require('dotenv').config();
const express = require('express');


const app = express();
const port = 2525;


app.use(express.json())
app.use(express.static('public'));


app.get('/health',(req,res)=>{
    res.json({ok: true})
})


app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
});