import { redis } from '../../shared/config/redis.js';
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
    if (!requiredColumns.every(col => bodyKeys.includes(col))) return res.status(400).json({err: "Missing Required Fields: ['name','price','stock']"})

    try {
        const product = await Product.create({name,price,stock})
        await redis.set(`${product.id}:STOCK`,String(product.stock))
        return res.json({message:`success create ${name} Product with id ${product.id}`})
    }catch(err){
        return res.status(500).json({ error: err.message });
    }
}    


export const productStockStream = async (req,res) =>{
    // setting up SSE connection
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    res.timeout?.(0);

    const productId = req.params.id;


    const channel = `${productId}:STOCK`;
    const cacheStock = await redis.get(channel);
    console.log(cacheStock)
    if (!cacheStock){
        console.log(`[Warning] Stock of ${productId} not found on redis`)
        console.log(`[PLAN-B] Checking DB...`)
        const stock = await Product.findOne({
            attributes: ["stock"],
            where: {
                id: productId
            }
        })
        console.log(stock)
        if (!stock) {
            console.log("[PLAN-B] Damn... This is big problem. Please call 911!");
            res.end();
            return
        };
        redis.set(channel,String(stock))
        redis.publish(channel,String(stock));
    }
    const sub = redis.duplicate();
    await sub.subscribe(channel);
    console.log(`Subscribed to ${channel} for realtime stock storage updates`);

    const onMessage = (ch,message) => {
        if (ch !== channel) return;
        res.write(`event: stock\n`);
        res.write(`data: ${JSON.stringify({ stock: Number(message) })}\n\n`);
    };
    sub.on("message",onMessage);

    const heartbeat = setInterval(() => {
    res.write(`: ping\n\n`); 
  }, 15000);



    const disconnect = async () => {
    try{
        clearInterval(heartbeat);
        sub.off("message", onMessage);
        await sub.unsubscribe(driverChannel);
        await sub.quit();
        res.end();
        console.log('Client disconnected from stock storage stream');

        }catch(err){
            console.error("SSE cleanup error:", err);
        }
    }
    req.on('close', disconnect);
    req.on("aborted", disconnect);

}

export const decStockCount = async (req,res) =>{
    const {productId} = req.body;
    if (!productId) {
      return res.status(400).json({ error: "Missing productId" });
    }
    const channel = `${productId}:STOCK`;
    let cacheStock = await redis.get(channel);
    if (!cacheStock){
        const [affectedRows, updatedRows] = await Product.update(
            { stock: newStock },
            {
                where: { id: productId },
                returning: true, 
            }
        );
        if (affectedRows === 0) return res.status(404).json({error:"product-not-found"})
        cacheStock = updatedRows[0].dataValues.stock;

    }
    const newStock = String(cacheStock - 1);
    await redis.publish(channel,newStock);
    await redis.set(channel,newStock)
    return res.json({success: `Published new stock (${newStock}) to ${channel}`})
    
}