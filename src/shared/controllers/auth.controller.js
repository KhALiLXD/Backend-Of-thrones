import bcrypt from 'bcrypt';
import User from '../modules/users.js';
import {generateToken}  from '../utils/generateToken.js';

export const register = async (req,res) => {
    try {
        const { name, email, password } = req.body;

        if (!name || !email || !password) return res.status(400).json({err: 'name, email and password are required'})

        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) return res.status(400).json({err: 'invalid email format'})

        if (password.length < 6) return res.status(400).json({err: 'password must be at least 6 characters'})

        const existingUser = await User.findOne({ where: { email } });
        if (existingUser) return res.status(409).json({err: 'email already exists'})

        const hashedPassword = await bcrypt.hash(password, 10);

        const user = await User.create({
            name,
            email,
            password: hashedPassword
        });

        const token = await generateToken({
            userId: user.id,
            name: user.name,
            email: user.email
        });

        return res.status(201).json({
            message: 'user registered successfully',
            user: {
                id: user.id,
                name: user.name,
                email: user.email
            },
            token
        });
    } catch (err) {
        return res.status(500).json({error: err.message});
    }
};

export const login = async (req,res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) return res.status(400).json({err: 'email and password are required'})

        const user = await User.findOne({ where: { email } });
        if (!user) return res.status(401).json({err: 'invalid email or password'})

        const isValidPassword = await bcrypt.compare(password, user.password);
        if (!isValidPassword) return res.status(401).json({err: 'invalid email or password'})

        const token = await generateToken({
            userId: user.id,
            name: user.name,
            email: user.email
        });

        return res.json({
            message: 'login successful',
            user: {
                id: user.id,
                name: user.name,
                email: user.email
            },
            token
        });
    } catch (err) {
        return res.status(500).json({error: err.message});
    }
};

export const getProfile = async (req,res) => {
    try {
        const userId = req.user.userId;

        const user = await User.findByPk(userId, {
            attributes: ['id', 'name', 'email', 'created_at']
        });

        if (!user) return res.status(404).json({err: 'user not found'})

        return res.json({user: user.toJSON()});
    } catch (err) {
        return res.status(500).json({error: err.message});
    }
};