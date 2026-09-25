const express = require('express');
const router = express.Router();

const {
  register,
  login,
  refresh,
  logout,
  forgotPassword,
  resetPassword,
  getMe,
  updateProfile,
} = require('../controllers/authController');
const validate = require('../middlewares/validate');
const authenticate = require('../middlewares/auth');
const { authLimiter } = require('../middlewares/rateLimit');
const {
  registerSchema,
  loginSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  updateProfileSchema,
} = require('../validators/authValidators');

router.post('/register', authLimiter, 
  // validate(registerSchema),
   register);
router.post('/login', authLimiter, validate(loginSchema), login);
router.post('/refresh', refresh);
router.post('/logout', logout);
router.post('/forgot-password', authLimiter, validate(forgotPasswordSchema), forgotPassword);
router.post('/reset-password', authLimiter, validate(resetPasswordSchema), resetPassword);
router.get('/me', authenticate, getMe);
router.patch('/profile', authenticate,
  //  validate(updateProfileSchema), 
   updateProfile);

module.exports = router;
