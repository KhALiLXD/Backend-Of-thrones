import Order from '../../shared/modules/orders.js';

export const getOrder = async (req,res) =>{
    const orderId = req.params.id;
    if (!orderId) return res.status(404).json({err:"order not found"})

    const order = await Order.findByPk(orderId);

    res.json(order.toJSON())
}

export const createOrder = async (req,res) =>{
      const { user_id,product_id,status,total_price } = req.body;
    const bodyKeys = Object.keys(req.body);

    const requiredColumns = ['user_id','product_id','status','total_price']
    if (!requiredColumns.every(col => bodyKeys.includes(col))) return res.status(400).json({err: "Missing Required Fields:  ['user_id','product_id','status','total_price'] "})

    try {
        await Order.create({ user_id,product_id,status,total_price })
        return res.json({message: `success create Order`})
    }catch(err){
        return res.status(500).json({ error: err.message });
    }
}

