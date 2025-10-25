import Product from '../../shared/modules/products.js';

export const getProduct = async (req,res) => {
    const productId = req.params.id;
    if (!productId) return res.status(404).json({err:"product not found"})
    const product = await Product.findByPk(productId);

    return res.json(product.toJSON())
}

export const createProduct = async (req,res) =>{
    const { name, price, stock } = req.body;

    const bodyKeys = Object.keys(req.body);

    const requiredColumns = ['name','price','stock']
    if (!requiredColumns.every(col => bodyKeys.includes(col))) return res.status(400).json({err: "Invalid fields. It must be {name,price,stock}"})

    try {
        await Product.create({name,price,stock})
        return res.json({message:`success create ${name} Product`})
    }catch(err){
        return res.status(500).json({ error: err.message });
    }
}    