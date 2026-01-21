// ============================================================================
// AUTHENTICATION ROUTES
// ============================================================================
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { supabase, getUserByEmail, getUserById } = require('../lib/supabase');
const { sendEmail } = require('../lib/notifications');

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
const JWT_EXPIRES_IN = '7d';

// ============================================================================
// GENERATE JWT
// ============================================================================
function generateToken(user) {
  return jwt.sign(
    {
      userId: user.id,
      email: user.email,
      role: user.role,
      agencyId: user.agency_id,
      clientId: user.client_id
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

// ============================================================================
// AGENCY LOGIN
// ============================================================================
async function agencyLogin(req, res) {
  try {
    const { email, password } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }
    
    // Find user
    const user = await getUserByEmail(email.toLowerCase());
    
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    
    // Check if agency user
    if (!user.agency_id || !['agency_owner', 'agency_staff', 'super_admin'].includes(user.role)) {
      return res.status(401).json({ error: 'Invalid credentials for agency login' });
    }
    
    // Verify password
    if (!user.password_hash) {
      return res.status(401).json({ 
        error: 'Password not set',
        message: 'Please set your password using the link in your welcome email'
      });
    }
    
    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    
    // Update last login
    await supabase
      .from('users')
      .update({ last_login_at: new Date().toISOString() })
      .eq('id', user.id);
    
    await supabase
      .from('agencies')
      .update({ last_login_at: new Date().toISOString() })
      .eq('id', user.agency_id);
    
    // Generate token
    const token = generateToken(user);
    
    console.log('✅ Agency login:', user.email);
    
    res.json({
      success: true,
      token,
      user: {
        id: user.id,
        email: user.email,
        first_name: user.first_name,
        last_name: user.last_name,
        role: user.role
      },
      agency: user.agencies ? {
        id: user.agencies.id,
        name: user.agencies.name,
        slug: user.agencies.slug,
        status: user.agencies.status,
        subscription_status: user.agencies.subscription_status
      } : null
    });
    
  } catch (error) {
    console.error('❌ Agency login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
}

// ============================================================================
// CLIENT LOGIN
// ============================================================================
async function clientLogin(req, res) {
  try {
    const { email, password } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }
    
    // Find user
    const user = await getUserByEmail(email.toLowerCase());
    
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    
    // Check if client user
    if (!user.client_id || user.role !== 'client') {
      return res.status(401).json({ error: 'Invalid credentials for client login' });
    }
    
    // Verify password
    if (!user.password_hash) {
      return res.status(401).json({ 
        error: 'Password not set',
        message: 'Please set your password using the link in your welcome email'
      });
    }
    
    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    
    // Update last login
    await supabase
      .from('users')
      .update({ last_login_at: new Date().toISOString() })
      .eq('id', user.id);
    
    // Generate token
    const token = generateToken(user);
    
    console.log('✅ Client login:', user.email);
    
    res.json({
      success: true,
      token,
      user: {
        id: user.id,
        email: user.email,
        first_name: user.first_name,
        last_name: user.last_name,
        role: user.role
      },
      client: user.clients ? {
        id: user.clients.id,
        business_name: user.clients.business_name,
        status: user.clients.status,
        subscription_status: user.clients.subscription_status,
        phone_number: user.clients.vapi_phone_number
      } : null
    });
    
  } catch (error) {
    console.error('❌ Client login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
}

// ============================================================================
// VERIFY TOKEN
// ============================================================================
async function verifyToken(req, res) {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }
    
    const token = authHeader.split(' ')[1];
    
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      
      // Get fresh user data
      const user = await getUserById(decoded.userId);
      
      if (!user) {
        return res.status(401).json({ error: 'User not found' });
      }
      
      res.json({
        valid: true,
        user: {
          id: user.id,
          email: user.email,
          first_name: user.first_name,
          last_name: user.last_name,
          role: user.role,
          agency_id: user.agency_id,
          client_id: user.client_id
        }
      });
      
    } catch (jwtError) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    
  } catch (error) {
    console.error('❌ Token verification error:', error);
    res.status(500).json({ error: 'Token verification failed' });
  }
}

// ============================================================================
// SET PASSWORD (From welcome email link)
// ============================================================================
async function setPassword(req, res) {
  try {
    const { token, password } = req.body;
    
    if (!token || !password) {
      return res.status(400).json({ error: 'Token and password required' });
    }
    
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    
    // Find token
    const { data: tokenRecord, error: tokenError } = await supabase
      .from('password_reset_tokens')
      .select('*')
      .eq('token', token)
      .eq('used', false)
      .single();
    
    if (tokenError || !tokenRecord) {
      return res.status(400).json({ error: 'Invalid or expired token' });
    }
    
    // Check expiry
    if (new Date(tokenRecord.expires_at) < new Date()) {
      return res.status(400).json({ error: 'Token has expired' });
    }
    
    // Hash password
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);
    
    // Update user
    const { error: updateError } = await supabase
      .from('users')
      .update({ password_hash: passwordHash })
      .eq('id', tokenRecord.user_id);
    
    if (updateError) {
      console.error('❌ Password update error:', updateError);
      return res.status(500).json({ error: 'Failed to set password' });
    }
    
    // Mark token as used
    await supabase
      .from('password_reset_tokens')
      .update({ used: true })
      .eq('id', tokenRecord.id);
    
    // Get user for response
    const user = await getUserById(tokenRecord.user_id);
    
    // Generate login token
    const authToken = generateToken(user);
    
    console.log('✅ Password set for:', user.email);
    
    res.json({
      success: true,
      message: 'Password set successfully',
      token: authToken,
      user: {
        id: user.id,
        email: user.email,
        role: user.role
      }
    });
    
  } catch (error) {
    console.error('❌ Set password error:', error);
    res.status(500).json({ error: 'Failed to set password' });
  }
}

// ============================================================================
// REQUEST PASSWORD RESET
// ============================================================================
async function requestPasswordReset(req, res) {
  try {
    const { email } = req.body;
    
    if (!email) {
      return res.status(400).json({ error: 'Email required' });
    }
    
    const user = await getUserByEmail(email.toLowerCase());
    
    // Don't reveal if user exists
    if (!user) {
      return res.json({ 
        success: true, 
        message: 'If an account exists, a reset link has been sent' 
      });
    }
    
    // Generate token
    const crypto = require('crypto');
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + 1);
    
    await supabase.from('password_reset_tokens').insert({
      user_id: user.id,
      email: email.toLowerCase(),
      token: token,
      expires_at: expiresAt.toISOString(),
      used: false
    });
    
    // Send reset email
    const resetUrl = `${process.env.FRONTEND_URL}/auth/reset-password?token=${token}`;
    
    await sendEmail({
      to: email,
      subject: 'Reset Your Password',
      html: `
        <h2>Reset Your Password</h2>
        <p>Click the link below to reset your password. This link expires in 1 hour.</p>
        <p><a href="${resetUrl}">Reset Password</a></p>
        <p>If you didn't request this, you can ignore this email.</p>
      `
    });
    
    console.log('✅ Password reset email sent to:', email);
    
    res.json({ 
      success: true, 
      message: 'If an account exists, a reset link has been sent' 
    });
    
  } catch (error) {
    console.error('❌ Password reset request error:', error);
    res.status(500).json({ error: 'Failed to process request' });
  }
}

// ============================================================================
// AUTH MIDDLEWARE (For protected routes)
// ============================================================================
function authMiddleware(requiredRoles = []) {
  return async (req, res, next) => {
    try {
      const authHeader = req.headers.authorization;
      
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Authentication required' });
      }
      
      const token = authHeader.split(' ')[1];
      
      try {
        const decoded = jwt.verify(token, JWT_SECRET);
        
        // Check role if required
        if (requiredRoles.length > 0 && !requiredRoles.includes(decoded.role)) {
          return res.status(403).json({ error: 'Insufficient permissions' });
        }
        
        req.user = decoded;
        next();
        
      } catch (jwtError) {
        return res.status(401).json({ error: 'Invalid or expired token' });
      }
      
    } catch (error) {
      console.error('❌ Auth middleware error:', error);
      res.status(500).json({ error: 'Authentication failed' });
    }
  };
}

// ============================================================================
// EXPORTS
// ============================================================================
module.exports = {
  agencyLogin,
  clientLogin,
  verifyToken,
  setPassword,
  requestPasswordReset,
  authMiddleware,
  generateToken
};
