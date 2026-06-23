// ============================================================================
// KNOWLEDGE BASE ROUTES - VoiceAI Connect Multi-Tenant Backend
// Location: src/routes/knowledge-base.js
//
// WHAT THIS DOES (rewritten 2026-06-23):
// The client "Update Knowledge Base" form lets a client type business hours,
// services, FAQs, and additional info. This handler now writes those typed
// fields into the SAME place the live call path reads: the VAPI query-tool
// file behind client.vapi_query_tool_id.
//
// WHY IT CHANGED:
// Live calls use the dynamic assistant-request webhook. assistant-config-builder
// attaches knowledge via toolIds.push(client.vapi_query_tool_id) and the AI
// answers hours/services/FAQs by calling search_knowledge_base against that
// file. The OLD version of this handler PATCHed the static vapi_assistant_id's
// system prompt and wrote knowledge_base_data jsonb, neither of which the
// dynamic call path reads, so client edits never reached the live AI.
//
// HOW IT WORKS NOW:
//  1. Smart-merge the typed fields into the structured editable copy
//     (knowledge_base_data).
//  2. Pull the current live KB document (industry doc + scraped website
//     content) from the file behind vapi_query_tool_id.
//  3. Strip any prior client-provided block (delimited), then prepend a fresh
//     authoritative "Business-Provided Information" block built from the merged
//     fields. Prepending keeps client-typed facts from being trimmed by the
//     100k cap and surfaces them prominently to the query model.
//  4. Re-upload as a new VAPI file, create a new query tool, store the new
//     vapi_query_tool_id (the column the call path reads), and cache the
//     assembled doc in knowledge_base_content (what the "What Your AI Knows"
//     card reads).
//  5. Best-effort: point the static vapi_assistant_id at the new tool and
//     delete the previous tool/file. Both non-fatal.
//
// It does NOT touch client.system_prompt. The builder treats system_prompt as
// a base-prompt override; leaving it null preserves the regenerate-from-
// INDUSTRY_CONFIGS plus dynamic-blocks behavior that live calls rely on.
//
// NOTE ON knowledge_base_data: the agency scrape/reset routes in
// client-knowledge-base.js historically also wrote a {fileId, toolId} shape
// into knowledge_base_data, which collides with the {businessHours, services,
// faqs, additionalInfo} shape this handler uses. Those ids now also live in
// their own column (vapi_query_tool_id), so the id-shape in knowledge_base_data
// is redundant. This handler ignores the id-shape on read and writes only the
// structured editable copy. Fully separating that column is a follow-up in
// client-knowledge-base.js, not done here to keep this change surgical.
// ============================================================================

const fetch = require('node-fetch');
const FormData = require('form-data');
const { supabase } = require('../lib/supabase');
const { INDUSTRY_MAPPING, createQueryTool } = require('../lib/vapi');
const { INDUSTRY_KNOWLEDGE_BASES } = require('../lib/industry-knowledge-bases');

const VAPI_API_KEY = process.env.VAPI_API_KEY;

// Maximum assembled document size. Mirrors the website scraper's cap. VAPI
// handles 100k fine; we trim from the tail so the client-provided block at the
// top is never the part that gets cut.
const KB_MAX_CHARS = 100000;

// Stable delimiters around the client-provided block so repeated edits replace
// the block cleanly instead of stacking duplicate copies on every save.
const CLIENT_SECTION_START = '<!-- CLIENT_PROVIDED_INFO_START -->';
const CLIENT_SECTION_END = '<!-- CLIENT_PROVIDED_INFO_END -->';

// ============================================================================
// SMART MERGE - Only update fields that have new non-empty values
// Preserves previously saved fields when a save omits them.
// ============================================================================
function smartMerge(existingData, newData) {
  const result = { ...existingData };

  if (newData.businessHours && newData.businessHours.trim()) {
    result.businessHours = newData.businessHours;
  }
  if (newData.services && newData.services.trim()) {
    result.services = newData.services;
  }
  if (newData.faqs && newData.faqs.trim()) {
    result.faqs = newData.faqs;
  }
  if (newData.additionalInfo && newData.additionalInfo.trim()) {
    result.additionalInfo = newData.additionalInfo;
  }

  return result;
}

// ============================================================================
// BUILD CLIENT-PROVIDED SECTION
// Wrapped in delimiter comments so it can be found and replaced on the next
// edit. Uses its own top-level header (distinct from the scraper's
// "# BUSINESS DETAILS (Extracted from Website)" header) so the "What Your AI
// Knows" parser keeps working unchanged.
// ============================================================================
function buildClientProvidedSection(data) {
  const parts = [];
  parts.push(CLIENT_SECTION_START);
  parts.push('# Business-Provided Information');
  parts.push('The following details were provided directly by the business and are authoritative. Prefer them when answering.');

  if (data.businessHours && data.businessHours.trim()) {
    parts.push('');
    parts.push('## Business Hours');
    parts.push(data.businessHours.trim());
  }
  if (data.services && data.services.trim()) {
    parts.push('');
    parts.push('## Services and Pricing');
    parts.push(data.services.trim());
  }
  if (data.faqs && data.faqs.trim()) {
    parts.push('');
    parts.push('## Frequently Asked Questions');
    parts.push(data.faqs.trim());
  }
  if (data.additionalInfo && data.additionalInfo.trim()) {
    parts.push('');
    parts.push('## Additional Information');
    parts.push(data.additionalInfo.trim());
  }

  parts.push(CLIENT_SECTION_END);
  return parts.join('\n');
}

// ============================================================================
// STRIP CLIENT-PROVIDED SECTION
// Removes a previously inserted client block (delimiter to delimiter) so the
// new one replaces it. Leaves the rest of the document (industry doc + scraped
// website content) intact.
// ============================================================================
function stripClientSection(doc) {
  if (!doc) return doc;
  const startIdx = doc.indexOf(CLIENT_SECTION_START);
  const endIdx = doc.indexOf(CLIENT_SECTION_END);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) return doc;

  const before = doc.slice(0, startIdx).replace(/\s+$/, '');
  const after = doc.slice(endIdx + CLIENT_SECTION_END.length).replace(/^\s+/, '');
  return [before, after].filter(Boolean).join('\n\n');
}

// ============================================================================
// FETCH CURRENT LIVE KB DOCUMENT
// Reads what the AI actually uses: walk vapi_query_tool_id -> tool ->
// knowledgeBases[0].fileIds[0] -> /file/:id/content. Returns the document text
// AND the old file id (so the caller can clean it up after swapping). Falls
// back to the cached knowledge_base_content column if the VAPI read fails.
// ============================================================================
async function fetchCurrentKbDoc(client) {
  let doc = null;
  let oldFileId = null;

  if (client.vapi_query_tool_id) {
    try {
      const tRes = await fetch(`https://api.vapi.ai/tool/${client.vapi_query_tool_id}`, {
        headers: { 'Authorization': `Bearer ${VAPI_API_KEY}` },
      });
      if (tRes.ok) {
        const tool = await tRes.json();
        oldFileId = tool.knowledgeBases?.[0]?.fileIds?.[0] || null;
        if (oldFileId) {
          const fRes = await fetch(`https://api.vapi.ai/file/${oldFileId}/content`, {
            headers: { 'Authorization': `Bearer ${VAPI_API_KEY}` },
          });
          if (fRes.ok) {
            const c = await fRes.text();
            if (c && c.trim().length > 0) doc = c;
          }
        }
      } else {
        console.warn(`⚠️ Could not fetch query tool ${client.vapi_query_tool_id}: HTTP ${tRes.status}`);
      }
    } catch (err) {
      console.warn('⚠️ Could not read current KB from VAPI:', err.message);
    }
  }

  if ((!doc || !doc.trim()) && client.knowledge_base_content && client.knowledge_base_content.trim()) {
    doc = client.knowledge_base_content;
  }

  return { doc, oldFileId };
}

// ============================================================================
// UPLOAD KB FILE TO VAPI
// Mirrors createIndustryKnowledgeBase's upload (FormData + knownLength, which
// prevents "Unexpected end of form" on large buffers). Returns the new file id.
// ============================================================================
async function uploadKbFile(fullContent, businessName) {
  const contentBuffer = Buffer.from(fullContent, 'utf-8');
  console.log(`📚 Uploading updated KB for ${businessName}: ${fullContent.length} chars, ${contentBuffer.length} bytes`);

  const form = new FormData();
  form.append('file', contentBuffer, {
    filename: `${businessName.replace(/\s+/g, '_')}_knowledge.txt`,
    contentType: 'text/plain',
    knownLength: contentBuffer.length,
  });

  const uploadResponse = await fetch('https://api.vapi.ai/file', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${VAPI_API_KEY}`, ...form.getHeaders() },
    body: form,
  });

  if (!uploadResponse.ok) {
    const errText = await uploadResponse.text().catch(() => '');
    throw new Error(`KB file upload failed (HTTP ${uploadResponse.status}): ${errText.slice(0, 200)}`);
  }

  const uploadData = await uploadResponse.json();
  console.log(`✅ KB file uploaded: ${uploadData.id}`);
  return uploadData.id;
}

// ============================================================================
// SWAP QUERY TOOL ON THE STATIC ASSISTANT
// Points vapi_assistant_id's model.toolIds at the new tool while preserving
// the rest of the model (transferCall etc. live in model.tools, untouched).
// The dynamic call path reads vapi_query_tool_id from the DB, so this is a
// belt-and-suspenders update for the static assistant; failure is non-fatal.
// ============================================================================
async function swapToolOnAssistant(assistantId, newToolId) {
  const getRes = await fetch(`https://api.vapi.ai/assistant/${assistantId}`, {
    headers: { 'Authorization': `Bearer ${VAPI_API_KEY}` },
  });
  if (!getRes.ok) throw new Error(`Failed to fetch assistant ${assistantId} from VAPI (HTTP ${getRes.status})`);

  const assistant = await getRes.json();
  const currentModel = assistant.model || {};
  const updatedModel = { ...currentModel, toolIds: [newToolId] };

  const patchRes = await fetch(`https://api.vapi.ai/assistant/${assistantId}`, {
    method: 'PATCH',
    headers: { 'Authorization': `Bearer ${VAPI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: updatedModel }),
  });
  if (!patchRes.ok) {
    const errText = await patchRes.text().catch(() => '');
    throw new Error(`Assistant PATCH failed (HTTP ${patchRes.status}): ${errText.slice(0, 200)}`);
  }
  console.log(`✅ Assistant ${assistantId} toolIds updated to [${newToolId}]`);
}

// ============================================================================
// CLEAN UP THE PREVIOUS TOOL + FILE (best-effort, non-fatal)
// After the swap, the old query tool and its file are unreferenced. Deleting
// them keeps VAPI from accumulating orphans on every edit.
// ============================================================================
async function cleanupOldVapiKb(oldToolId, oldFileId, newToolId) {
  if (oldToolId && oldToolId !== newToolId) {
    try {
      await fetch(`https://api.vapi.ai/tool/${oldToolId}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${VAPI_API_KEY}` },
      });
      console.log(`🧹 Deleted previous query tool: ${oldToolId}`);
    } catch (err) {
      console.warn('⚠️ Old query tool delete failed (non-fatal):', err.message);
    }
  }
  if (oldFileId) {
    try {
      await fetch(`https://api.vapi.ai/file/${oldFileId}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${VAPI_API_KEY}` },
      });
      console.log(`🧹 Deleted previous KB file: ${oldFileId}`);
    } catch (err) {
      console.warn('⚠️ Old KB file delete failed (non-fatal):', err.message);
    }
  }
}

// ============================================================================
// UPDATE KNOWLEDGE BASE - Main handler
// POST /api/knowledge-base/update
// ============================================================================
async function updateKnowledgeBase(req, res) {
  try {
    console.log('');
    console.log('📚 ====== KNOWLEDGE BASE UPDATE (query-tool file) ======');

    const {
      clientId,
      businessHours,
      services,
      faqs,
      additionalInfo,
      websiteUrl,
    } = req.body;

    if (!clientId) {
      return res.status(400).json({ success: false, error: 'Client ID required' });
    }

    // ========================================
    // 1. GET CLIENT DATA
    // ========================================
    const { data: client, error: clientError } = await supabase
      .from('clients')
      .select('*')
      .eq('id', clientId)
      .single();

    if (clientError || !client) {
      console.error('❌ Client not found:', clientError);
      return res.status(404).json({ success: false, error: 'Client not found' });
    }

    console.log('✅ Client:', client.business_name);
    console.log('   Query tool:', client.vapi_query_tool_id || '(none)');

    // ========================================
    // 2. SMART MERGE the structured editable copy.
    //    Ignore the legacy {fileId, toolId} shape so we never treat ids as
    //    typed content. Start fresh structured data if that's what's stored.
    // ========================================
    const kbData = client.knowledge_base_data || {};
    const looksLikeIdShape = !!(kbData.fileId || kbData.toolId);
    const existingStructured = looksLikeIdShape ? {} : kbData;

    const mergedData = smartMerge(existingStructured, {
      businessHours: businessHours || '',
      services: services || '',
      faqs: faqs || '',
      additionalInfo: additionalInfo || '',
    });

    const hasClientContent = !!(
      (mergedData.businessHours && mergedData.businessHours.trim()) ||
      (mergedData.services && mergedData.services.trim()) ||
      (mergedData.faqs && mergedData.faqs.trim()) ||
      (mergedData.additionalInfo && mergedData.additionalInfo.trim())
    );
    console.log('📦 Structured fields present:', Object.keys(mergedData).filter(k => mergedData[k] && String(mergedData[k]).trim()));

    // ========================================
    // 3. PULL the current live KB document and old file id.
    // ========================================
    const { doc: currentDoc, oldFileId } = await fetchCurrentKbDoc(client);
    const oldToolId = client.vapi_query_tool_id || null;

    // ========================================
    // 4. ASSEMBLE the new document.
    //    Strip any prior client block, then prepend the fresh one. If there's
    //    no existing document at all (KB never built, e.g. signup scrape
    //    failed), rebuild the base from the industry doc so the AI still gets
    //    a real knowledge base.
    // ========================================
    let baseDoc = stripClientSection(currentDoc);

    if (!baseDoc || !baseDoc.trim()) {
      const industryKey = INDUSTRY_MAPPING[client.industry] || 'professional_services';
      const gen = INDUSTRY_KNOWLEDGE_BASES[industryKey] || INDUSTRY_KNOWLEDGE_BASES['professional_services'];
      baseDoc = gen(client.business_name);
      console.log(`📄 No existing KB document found, rebuilt base from industry doc (${industryKey})`);
    }

    let newDoc;
    if (hasClientContent) {
      const clientSection = buildClientProvidedSection(mergedData);
      newDoc = `${clientSection}\n\n${baseDoc}`;
    } else {
      // No typed content: keep the base document clean (no empty client block).
      newDoc = baseDoc;
    }

    if (newDoc.length > KB_MAX_CHARS) {
      console.log(`✂️ Assembled doc ${newDoc.length} chars, trimming tail to ${KB_MAX_CHARS}`);
      newDoc = newDoc.slice(0, KB_MAX_CHARS);
    }
    console.log('📝 New KB document length:', newDoc.length, 'chars');

    // ========================================
    // 5. UPLOAD new file + CREATE new query tool (the live call path).
    // ========================================
    const newFileId = await uploadKbFile(newDoc, client.business_name);
    const newToolId = await createQueryTool(newFileId, client.business_name);
    if (!newToolId) {
      throw new Error('Failed to create knowledge base query tool');
    }
    console.log(`🔧 New query tool created: ${newToolId}`);

    // ========================================
    // 6. Point the static assistant at the new tool (non-fatal).
    // ========================================
    if (client.vapi_assistant_id) {
      try {
        await swapToolOnAssistant(client.vapi_assistant_id, newToolId);
      } catch (e) {
        console.warn('⚠️ Static assistant tool swap failed (non-fatal):', e.message);
      }
    }

    // ========================================
    // 7. PERSIST. vapi_query_tool_id is what the dynamic call path reads.
    //    knowledge_base_content is the cached assembled doc the "What Your AI
    //    Knows" card reads. knowledge_base_data is the structured editable copy.
    // ========================================
    const { error: updateError } = await supabase
      .from('clients')
      .update({
        vapi_query_tool_id: newToolId,
        knowledge_base_content: newDoc,
        knowledge_base_data: mergedData,
        knowledge_base_updated_at: new Date().toISOString(),
        business_website: websiteUrl || client.business_website,
      })
      .eq('id', clientId);

    if (updateError) {
      console.error('❌ Database update error:', updateError);
      // The new tool/file are live in VAPI but the DB still points at the old
      // tool. Clean up the new orphan so we don't leak it, leave the client on
      // its previous (working) tool.
      cleanupOldVapiKb(newToolId, newFileId, oldToolId).catch(() => {});
      throw new Error('Failed to save knowledge base to database');
    }

    console.log('✅ Database updated, client now points at new query tool');

    // ========================================
    // 8. Best-effort cleanup of the previous tool + file.
    // ========================================
    cleanupOldVapiKb(oldToolId, oldFileId, newToolId).catch(() => {});

    console.log('📚 ====== UPDATE COMPLETE ======');
    console.log('');

    return res.json({
      success: true,
      message: 'Knowledge base updated successfully',
    });

  } catch (error) {
    console.error('❌ Knowledge base update error:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to update knowledge base',
    });
  }
}

module.exports = {
  updateKnowledgeBase,
  smartMerge,
  buildClientProvidedSection,
  stripClientSection,
};