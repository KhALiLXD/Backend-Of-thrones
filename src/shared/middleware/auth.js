import jwt from 'jsonwebtoken';

export const verifyToken = (req,res,next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) return res.status(401).json({err: 'no token provided'})

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user = decoded;
        next();
    } catch (err) {
        if (err.name === 'TokenExpiredError') return res.status(401).json({err: 'token expired'})
        if (err.name === 'JsonWebTokenError') return res.status(401).json({err: 'invalid token'})
        return res.status(500).json({err: 'authentication failed'});
    }
};
