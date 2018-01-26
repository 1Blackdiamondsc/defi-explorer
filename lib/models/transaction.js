const mongoose = require('mongoose');
const Schema = mongoose.Schema;
const async = require('async');

const config = require('../config');
const Coin = mongoose.model('Coin');

const TransactionSchema = new Schema({
  txid: String,
  network: String,
  chain: String,
  blockHeight: Number,
  blockHash: String,
  blockTime: Date,
  blockTimeNormalized: Date,
  coinbase: Boolean,
  fee: Number,
  size: Number,
  locktime: Number,
  wallets: { type: [Schema.Types.ObjectId] },
});

TransactionSchema.index({txid: 1});
TransactionSchema.index({blockHeight: 1});
TransactionSchema.index({blockHash: 1});
TransactionSchema.index({blockTimeNormalized: 1});
TransactionSchema.index({wallets: 1});

TransactionSchema.statics.addTransaction = async function(params, callback){
  let txid = params.transaction.rhash();
  let wallets = await Coin.aggregate([
    {
      $match: {
        $or: [
          { spentTxid: txid },
          { mintTxid: txid }
        ]
      }
    },
    { $unwind: '$wallets' },
    { $group: { _id: null, wallets: { $addToSet: '$wallets' } } },
    { $project: { _id: false } }
  ]);
  if (wallets.length){
    wallets = wallets[0].wallets;
  }
  Transaction.findOneAndUpdate({ txid: params.transaction.rhash()}, {
    txid: txid,
    network: params.network,
    blockHeight: params.blockHeight,
    blockHash: params.blockHash,
    blockTime: params.blockTime,
    blockTimeNormalized: params.blockTimeNormalized,
    coinbase: params.transaction.isCoinbase(),
    size: params.transaction.getSize(),
    locktime: params.transaction.locktime,
    wallets: wallets
  }, { upsert: true, runValidators: false, fields: {}}).exec(callback);
};

TransactionSchema.statics.mintCoins = function(params, callback){
  async.eachOfLimit(params.transaction.outputs, config.maxPoolSize, async function (output, index, outputCb) {
    let address = output.getAddress();
    if (address) {
      address = address.toString(config.network);
    }
    let wallets = await mongoose.model('WalletAddress').find({ address: address }).lean().exec();
    wallets = wallets.map((wallet) => wallet.wallet);
    Coin.findOneAndUpdate({ mintTxid: params.transaction.rhash(), mintIndex: index},{
      network: params.network,
      mintHeight: params.mintHeight,
      coinbase: params.transaction.isCoinbase(),
      value: output.value,
      address: address,
      script: output.script.raw,
      spentHeight: -2,
      wallets: wallets
    }, { upsert: true, runValidators: false, fields: {}}).exec(outputCb);
  }, callback);
};

TransactionSchema.statics.spendCoins = function(params, callback){
  async.eachLimit(params.transaction.inputs, config.maxPoolSize, function (input, inputCb) {
    if (params.transaction.isCoinbase()) {
      return inputCb();
    }
    let prevTx = input.prevout.rhash();
    Coin.findOneAndUpdate({
      mintTxid: prevTx,
      mintIndex: input.prevout.index
    }, {
        spentTxid: params.transaction.rhash(),
        spentHeight: params.spentHeight
      }, { runValidators: false, fields: {}}, inputCb);
  }, callback);
};

TransactionSchema.statics.getTransactions = function(params){
  let query = params.query;
  return this.collection.aggregate([
    { $match: query },
    {
      $lookup:
        {
          from: 'coins',
          localField: 'txid',
          foreignField: 'spentTxid',
          as: 'inputs'
        }
    },
    {
      $lookup:
        {
          from: 'coins',
          localField: 'txid',
          foreignField: 'mintTxid',
          as: 'outputs'
        }
    }
  ]);
};

TransactionSchema.statics._apiTransform = function(tx, options) {
  let transform = {
    txid: tx.txid,
    network: tx.network,
    blockHeight: tx.blockHeight,
    blockHash: tx.blockHash,
    blockTime: tx.blockTime,
    blockTimeNormalized: tx.blockTimeNormalized,
    coinbase: tx.coinbase,
    fee: tx.fee,
  };
  if(options && options.object) {
    return transform;
  }
  return JSON.stringify(transform);
};

var Transaction = module.exports = mongoose.model('Transaction', TransactionSchema);