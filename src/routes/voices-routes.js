// ============================================================================
// VOICES ROUTE - Standalone endpoint for voice listing
// Mounted at /api/voices (separate from /api/client routes)
// ============================================================================
const express = require('express');
const router = express.Router();

// Import voice options from client-routes
const { VOICE_OPTIONS } = require('./client-routes');

// ============================================================================
// GET /api/voices - List all available voices
// Returns format expected by frontend: { success: true, grouped: { female: [], male: [] } }
// ============================================================================
router.get('/', async (req, res) => {
  try {
    // Group voices by gender
    const femaleVoices = VOICE_OPTIONS.filter(v => v.gender === 'female');
    const maleVoices = VOICE_OPTIONS.filter(v => v.gender === 'male');
    
    // Sort: recommended first, then alphabetically
    const sortVoices = (voices) => {
      return voices.sort((a, b) => {
        if (a.recommended && !b.recommended) return -1;
        if (!a.recommended && b.recommended) return 1;
        return a.name.localeCompare(b.name);
      });
    };

    res.json({
      success: true,
      total: VOICE_OPTIONS.length,
      grouped: {
        female: sortVoices(femaleVoices),
        male: sortVoices(maleVoices)
      },
      voices: VOICE_OPTIONS // Also include flat list
    });
  } catch (error) {
    console.error('Error fetching voices:', error);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

module.exports = router;