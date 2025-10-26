import express from 'express';
import { register, login, getProfile } from '../controllers/auth.controller.js';
import { verifyToken } from '../../shared/middleware/auth.js';

const router = express.Router();

router.post('/register', register);
router.post('/login', login);
router.get('/me', verifyToken, getProfile);

export default router;