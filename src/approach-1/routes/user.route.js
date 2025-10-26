import express from 'express'

import { getUserProfile,register } from '../controllers/user.controller.js';
const router = express.Router()


router.get('/profile/:id',getUserProfile)
router.post('/register',register)

export default router;