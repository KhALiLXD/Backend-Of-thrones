// const express = require('express')

import express from 'express'

import {ping} from '../controllers/ping.js';
import { idempotency } from '../middleware/idempotency.js';

const router = express.Router()
router.get('/ping',idempotency,ping)


export default router;