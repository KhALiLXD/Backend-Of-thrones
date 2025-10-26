import User from "../../shared/modules/users.js";

export const getUserProfile = async (res,req) =>{
    const userId = req.params.id;
    if (!userId) return res.status(404).json({err:"user not found"})
    const user = await User.findByPk(productId);

    return res.json(user.toJSON())
}

export const register = async (res,req) =>{
      const { name, email } = req.body;
    const bodyKeys = Object.keys(req.body);

    const requiredColumns = ['name','email']
    if (!requiredColumns.every(col => bodyKeys.includes(col))) return res.status(400).json({err: "Missing Required Fields: ['name','email']"})
    if (!email.test("^[^\s@]+@[^\s@]+\.[^\s@]+$")) return res.status(400).json({err: "Please enter valid email"})
    try {
        await User.create({name,email})
        return res.json({message:`Welcome, ${name}`})
    }catch(err){
        return res.status(500).json({ error: err.message });
    }
}