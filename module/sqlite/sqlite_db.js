const { Sequelize } = require("sequelize")

const sequelize = new Sequelize({
    dialect: 'sqlite',
    storage: "./inemuri.sqlite",
    logging: false
  });
  
  module.exports = sequelize