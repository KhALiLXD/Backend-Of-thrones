import Order from '../../shared/modules/orders.js';

export const getOrder = async (req,res) =>{
    const orderId = req.parms.id
    const order = await Order.findByPk(orderId);

    res.json({order})
}

export const createOrder = async (req,res) =>{
    
}

