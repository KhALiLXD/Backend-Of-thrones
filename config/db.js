const mysql = require('mysql2')
console.log(process.env.DATABASE)
const connection = mysql.createConnection({
    host: process.env.HOST,
    user: process.env.USER,
    password: process.env.PASSWORD,
    database: process.env.DATABASE
})

connection.connect(err =>{
    if (err) throw err;
    console.log('connection to db done')
})

module.exports = connection;