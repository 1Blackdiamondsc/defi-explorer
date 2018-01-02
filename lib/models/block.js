'use strict';
var Block;
var bcoin = require('bcoin');
var mongoose = require('mongoose');
var Schema = mongoose.Schema;
var async = require('async');
var _ = require('underscore');

var config = require('../config');
var Transaction = mongoose.model('Transaction');

var BlockSchema = new Schema({
  network: String,
  mainChain: Boolean,
  height: Number,
  hash: String,
  version: Number,
  merkleRoot: String,
  time: Date,
  timeNormalized: Date,
  nonce: Number,
  previousBlockHash: String,
  nextBlockHash: String,
  transactionCount: Number,
  size: Number,
  bits: Number,
  reward: Number,
  processed: Boolean
});

BlockSchema.index({hash: 1}, {unique: true});
BlockSchema.index({height: 1});
BlockSchema.index({time: 1});
BlockSchema.index({timeNormalized: 1});
BlockSchema.index({mainChain: 1});
BlockSchema.index({previousBlockHash: 1, mainChain: 1});

BlockSchema.statics.addBlock = function(block, callback){
  var blockTime = block.ts * 1000;
  var blockTimeNormalized;
  var height;
  async.series([
    function(cb){
      Block.handleReorg(block, cb);
    },
    function(cb){
      Block.findOne({hash: bcoin.util.revHex(block.prevBlock)}, function(err, previousBlock) {
        if(err) {
          return cb(err);
        }
        if(!previousBlock &&
          block.prevBlock !== bcoin.network.get(config.network).genesis.hash &&
          block.prevBlock !== '0000000000000000000000000000000000000000000000000000000000000000'){
          return cb(new Error('No previous block found'));
        }
        blockTimeNormalized = blockTime;
        if(previousBlock && blockTime <= previousBlock.timeNormalized.getTime()) {
          blockTimeNormalized = previousBlock.timeNormalized.getTime() + 1;
        }
        height = (previousBlock && previousBlock.height + 1) || 1;
        Block.update({hash: block.rhash()}, {
          network: config.network,
          mainChain: true,
          height: height,
          version: block.version,
          previousBlockHash: bcoin.util.revHex(block.prevBlock),
          merkleRoot: block.merkleRoot,
          time: new Date(blockTime),
          timeNormalized: new Date(blockTimeNormalized),
          bits: block.bits,
          nonce: block.nonce,
          transactionCount: block.txs.length,
          size: block._size,
          reward: bcoin.consensus.getReward(height, bcoin.network.get(config.network).halvingInterval)
        }, {upsert: true}, function(err){
          if (err){
            return cb(err);
          }
          if (!previousBlock){
            return cb();
          }
          previousBlock.nextBlockHash = block.rhash();
          previousBlock.save(cb);
        });
      });
    },
    function(cb){
      var transactionInserts = [];
      var coinInserts = [];
      var coinSpends = [];
      block.txs.forEach((tx) => {
        transactionInserts.push({
          updateOne: {
            filter: {
              txid: tx.rhash()
            },
            update: {
              network: config.network,
              blockHeight: height,
              blockHash: block.rhash(),
              blockTime: blockTime,
              blockTimeNormalized: blockTimeNormalized,
              mainChain: true,
              mempool: false,
              coinbase: tx.isCoinbase(),
              size: tx.getSize(),
              locktime: tx.locktime
            },
            upsert: true
          }
        });
        tx.inputs.forEach((input) => {
          coinSpends.push({
            updateOne: {
              filter: {
                mintTxid: input.prevout.rhash(),
                mintIndex: input.prevout.index
              },
              update: {
                spentTxid: tx.rhash()
              }
            }
          });
        });
      });

      async.eachLimit(block.txs, 4, function(tx, txCb){
        async.eachOfLimit(tx.outputs, 4, function(output, index, outputCb){
          var address = output.getAddress();
          if (address) {
            address = address.toString(config.network);
          }
          mongoose.model('WalletAddress').find({ address: address }).lean().exec(function(err, wallets){
            coinInserts.push({
              updateOne: {
                filter: {
                  mintTxid: tx.rhash(),
                  mintIndex: index
                },
                update: {
                  coinbase: tx.isCoinbase(),
                  value: output.value,
                  address: address,
                  wallets: _.pluck(wallets, 'wallet')
                },
                upsert: true
              }
            });
            outputCb();
          });
        }, txCb);
      }, function(err){
        async.series([
          function(cb){
            mongoose.model('Transaction').bulkWrite(transactionInserts, {ordered:false}, function(err, result){
              cb(err);
            });
          },
          function (cb) {
            mongoose.model('Coin').bulkWrite(coinInserts, { ordered: false },function (err, result) {
              cb(err);
            });
          },
          function (cb) {
            mongoose.model('Coin').bulkWrite(coinSpends, { ordered: false }, function (err, result) {
              cb(err);
            });
          }
        ], function(err){
          cb(err);
        });
      });
    }
  ], function(err){
    if(err){
      return callback(err);
    }
    Block.update({hash: block.rhash()}, {$set: {processed:true}}, callback);
  });
};

BlockSchema.statics.getPoolInfo = function(coinbase){
  //TODO need to make this actually parse the coinbase input and map to miner strings
  // also should go somewhere else
  return 'miningPool';
};

BlockSchema.statics.getLocalTip = function(callback) {
  Block.find({mainChain: true, processed: true, network: config.network}).sort({height: -1}).limit(1).exec(function(err, bestBlock) {
    if(err) {
      return callback(err);
    }
    bestBlock = bestBlock[0] || {height: 0};
    callback(null, bestBlock);
  });
};

BlockSchema.statics.getLocatorHashes = function(callback) {
  Block.find({mainChain: true, processed: true, network: config.network}).sort({height: -1}).limit(30).exec(function(err, locatorBlocks) {
    if(err) {
      return callback(err);
    }
    if(locatorBlocks.length < 2) {
      return callback(null, [Array(65).join('0')]);
    }
    locatorBlocks = _.pluck(locatorBlocks, 'hash');
    callback(null, locatorBlocks);
  });
};

BlockSchema.statics.handleReorg = function(block, callback) {
  Block.getLocalTip(function(err, localTip) {
    if(err) {
      return callback(err);
    }
    if(localTip.hash === bcoin.util.revHex(block.prevBlock)) {
      return callback();
    }
    if(localTip.height === 0){
      return callback();
    }
    console.log('Reorg detected at height ' + localTip.height);
    console.log('Local tip was ' + localTip.hash);
    console.log('Incoming block had previous block' + bcoin.util.revHex(block.prevBlock));
    Block.update({mainChain: true, network: config.network, height: {$gte: localTip.height}},
      {$set: {mainChain: false}}, {multi: true}, function(err) {
        if(err) {
          return callback(err);
        }
        Transaction.update({network: config.network, blockHeight: {$gte: localTip.height}},
          {$set: {mainChain: false}}, {multi: true}, function(err) {
            if(err) {
              return callback(err);
            }
            callback(new Error('REORG'));
          });
      });
  });
};


BlockSchema.statics._apiTransform = function(block, options){
  var transform = {
    hash: block.hash,
    height: block.height,
    version: block.version,
    size: block.size,
    merkleRoot: block.merkleRoot,
    time: block.time.getTime()/1000,
    timeNormalized: block.timeNormalized,
    nonce: block.nonce,
    bits: block.bits,
    difficulty: block.difficulty,
    chainWork: block.chainWork,
    previousBlockHash: block.previousBlockHash,
    nextBlockHash: block.nextBlockHash,
    reward: block.reward,
    isMainChain: block.mainChain,
    minedBy: Block.getPoolInfo(block.minedBy)
  };
  if(options && options.object){
    return transform;
  }
  return JSON.stringify(transform);
};

module.exports = Block = mongoose.model('Block', BlockSchema);