'use strict';

var mongoose = require('mongoose');
mongoose.connect('mongodb://localhost/fullNodePlus');
var Transaction = require('./lib/models/Transaction');
var rpc = require('./lib/rpc');
var async = require('async');
var _ = require('underscore');

function getBlockTransactions(block, callback){
  async.mapLimit(block.tx, 64, function (tx, cb) {
    rpc.getTransaction(tx, function (err, transaction) {
      if (block.height === 0) {
        return cb(null, {
          hash: tx,
          vout: [],
          vin: []
        });
      }
      if (err){
        return cb(err);
      }
      cb(err, transaction);
    });
  }, function (err, transactions) {
    callback(err, transactions);
  });
}

function processBlockTransactions(blockHeight, blockHash, transactions, callback){
  var resultTransactions = [];
  async.eachLimit(transactions, 32, function(transaction, txCb){
    Transaction.count({txid: transaction.hash, blockHeight: blockHeight, blockHash: blockHash}, function(err, hasTx){
      if (err){
        return txCb(err);
      }
      if (hasTx){
        return txCb();
      }
      var newTx = new Transaction();
      newTx.txid = transaction.hash;
      newTx.blockHeight = blockHeight;
      newTx.blockHash = blockHash;

      transaction.vout.forEach(function (vout) {
        newTx.outputs.push({
          vout: vout.n,
          amount: vout.value,
          address: vout.scriptPubKey.addresses && vout.scriptPubKey.addresses[0]
        });
      });

      async.eachLimit(transaction.vin, 1, function (input, inputCb) {
        if (input.coinbase) {
          newTx.coinbase = true;
          newTx.inputs.push({
            amount: newTx.outputs[0].amount
          });
          return inputCb();
        }

        Transaction.findOne({ txid: input.txid }, function (err, inputTx) {
          if (err) {
            console.error(err);
            return inputCb(err);
          }
          if (!inputTx) {
            inputTx = _.findWhere(transactions, { txid: input.txid });
            if (inputTx) {
              inputTx = {
                outputs: inputTx.vout.map(function (vout) {
                  return {
                    vout: vout.n,
                    amount: vout.value,
                    address: vout.scriptPubKey.addresses && vout.scriptPubKey.addresses[0]
                  };
                }
                )
              };
            }
          }
          if (err || !inputTx) {
            return inputCb();
          }
          var utxo = _.findWhere(inputTx.outputs, { vout: input.vout });
          if (!utxo) {
            return inputCb();
          }
          newTx.inputs.push({
            txid: input.txid,
            vout: input.vout,
            address: utxo.address,
            amount: utxo.amount
          });
          inputCb();
        });
      }, function () {
        var totalInputs = _.reduce(newTx.inputs, function (total, input) { return total + input.amount; }, 0);
        var totalOutputs = _.reduce(newTx.outputs, function (total, output) { return total + output.amount; }, 0);
        newTx.fee = totalInputs - totalOutputs;
        resultTransactions.push(newTx);
        txCb();
      });
    });

  }, function(err){
    callback(err, resultTransactions);
  });
}

function insertTransactions(transactions, callback){
  if (!transactions.length){
    return callback();
  }
  transactions = transactions.map(function(transaction){
    return {
      insertOne:{
        document: transaction
      }
    };
  });
  Transaction.bulkWrite(transactions, callback);
}

rpc.getChainTip(function(err, chainTip){
  Transaction.find({}).limit(1).sort({ blockHeight: -1 }).exec(function (err, localTip) {
    localTip = (localTip[0] && localTip[0].blockHeight) || 0;
    var blockTimes = new Array(72);
    async.eachSeries(_.range(localTip, chainTip.height), function (blockN, blockCb) {
      var start = Date.now();
      rpc.getBlockByHeight(blockN, function(err, block){
        if (err) {
          return blockCb(err);
        }
        getBlockTransactions(block, function (err, transactions) {
          if (err){
            return blockCb(err);
          }
          processBlockTransactions(block.height, block.hash, transactions, function(err, transactions){
            insertTransactions(transactions, function(err){
              var end = Date.now();
              console.log('block per tx ms: ' + (end-start)/transactions.length);
              blockTimes.push(end - start);
              blockTimes.shift();
              var avgBlockTime = _.reduce(blockTimes, function (total, time) { return total + time; }, 0) / 72;
              if (!Number.isNaN(avgBlockTime)) {
                console.log('Estimated hours left: ' + (chainTip.height - blockN) * avgBlockTime / 1000 / 60 / 60);
              }
              console.log('added block: ' + blockN);
              blockCb(err);
            });
          });
        });
      });
    }, function (err) {
      if (err){
        console.error(err);
      }
      console.log('done');
    });
  });
});




