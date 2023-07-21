"use strict";

let Maya = module.exports;

let DashPhrase = require("dashphrase");
let DashHd = require("dashhd");
let DashKeys = require("dashkeys");
let DashTx = require("dashtx");
//@ts-ignore
let dashTx = DashTx.create({});

const INSIGHT_BASE_URL = "https://insight.dash.org/insight-api";
const DUST = 2000;

//let testWalletPhrase = "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong";
let testWalletPhrase =
  "donor actor must frost cotton wave custom sea behave rather second trip";
let walletPhrase = process.env.WALLET_PHRASE || testWalletPhrase;

/**
 * @typedef {DashTx.TxInputRaw & TxInputPart} TxInput
 * @typedef TxInputPart
 * @prop {Number} satoshis
 */

/**
 * @param {String} address - a normal Base58Check-encoded PubKeyHash
 * @param {Number} amount - Dash, in decimal form (not sats)
 * @param {String} memo - the maya command string
 */
Maya.transferToDash = async function (address, amount, memo = "") {
  let txHex = await Maya.createDashTransaction(address, amount, memo);
  console.log();
  console.log(`[DEBUG] raw transaction:`);
  console.log(txHex);
  console.log();
  console.log(`[DEBUG] inspect at https://live.blockcypher.com/dash/decodetx/`);
  console.log();

  // broadcast the transaction
  // let confirmation = await instantSend(txHex);
  // console.log(`[DEBUG] transaction confirmation:`, confirmation);

  // return confirmation;
};

/**
 * @param {String} address - a normal Base58Check-encoded PubKeyHash
 * @param {Number} amount - Dash, in decimal form (not sats)
 * @param {String} memo - the maya command string
 * @returns {Promise<String>} txHex
 */
Maya.createDashTransaction = async function (address, amount, memo = "") {
  // encode / decode input arguments to appropriate form for transaction
  let pubKeyHashBytes = await DashKeys.addrToPkh(address);
  let pubKeyHash = DashKeys.utils.bytesToHex(pubKeyHashBytes);
  let satoshis = DashTx.toSats(amount);
  let encoder = new TextEncoder();
  let memoBytes = encoder.encode(memo);
  let memoHex = DashKeys.utils.bytesToHex(memoBytes);

  // get the private key
  let salt = "";
  let seedBytes = await DashPhrase.toSeed(walletPhrase, salt);
  let walletKey = await DashHd.fromSeed(seedBytes);
  let accountIndex = 0;
  let usage = 0;
  let keyIndex = 0; // security note: reusing hard-coded key index leaks data
  let firstKeyPath = `m/44'/5'/${accountIndex}'/${usage}/${keyIndex}`;
  let addressKey = await DashHd.derivePath(walletKey, firstKeyPath);
  let primaryAddress = await DashHd.toAddr(addressKey.publicKey);
  console.log(`[DEBUG] primaryAddress:`, primaryAddress);

  // check the address balance
  let coins = await getUtxos(primaryAddress);
  console.log(`[DEBUG] coins:`, coins);

  // setup outputs
  /** @type {Array<DashTx.TxOutput>} */
  let outputs = [];
  let recipient = {
    pubKeyHash,
    satoshis,
  };
  outputs.push(recipient);
  if (memo) {
    outputs.push({ memo: memoHex, satoshis: 0 });
  }

  // create the transaction
  let txInfo = await createTx(coins, outputs, primaryAddress);
  console.log(`[DEBUG] transaction:`, txInfo);

  // sign the transaction
  let keys = [addressKey.privateKey];
  let txInfoSigned = await dashTx.hashAndSignAll(txInfo, keys);
  let txHex = txInfoSigned.transaction.toString();

  return txHex;
};

/**
 * @param {Array<TxInput>} coins
 * @param {Array<DashTx.TxOutput>} outputs
 * @param {String} changeAddress - change address
 */
async function createTx(coins, outputs, changeAddress) {
  // sort smallest first (ascending)
  coins.sort(function (a, b) {
    return a.satoshis - b.satoshis;
  });
  let balance = getBalance(coins);
  console.log(`[DEBUG] coin balance: ${balance}`);

  /** @type {Array<TxInput>} */
  let inputs = [];
  let fees = DashTx.appraise({ inputs, outputs });
  let fee = BigInt(fees.max);

  let subtotal = getBalance(outputs);
  let total = subtotal + fee;

  let totalIn = 0n;
  for (let input of coins) {
    inputs.push(input);
    let sats = BigInt(input.satoshis);
    totalIn += sats;
    total += BigInt(DashTx.MAX_INPUT_SIZE);
    if (totalIn < total) {
      continue;
    }
    break;
  }

  if (totalIn < total) {
    throw new Error(`balance ${totalIn} is too small for transaction ${total}`);
  }

  let changeLimit = DashTx.OUTPUT_SIZE + DUST;
  let change = totalIn - total;
  if (change >= changeLimit) {
    let changePkhBytes = await DashKeys.addrToPkh(changeAddress);
    let changePkhHex = DashKeys.utils.bytesToHex(changePkhBytes);
    change -= BigInt(DashTx.OUTPUT_SIZE);
    outputs.push({
      address: changeAddress,
      pubKeyHash: changePkhHex,
      satoshis: change,
    });
    total += BigInt(DashTx.OUTPUT_SIZE);
  }

  fee = total - subtotal;
  console.log(`[DEBUG] payment total: ${balance} (${subtotal} + ${fee} fee)`);

  let txInfo = {
    version: 3,
    inputs: inputs,
    outputs: outputs,
    locktime: 0,
  };

  return txInfo;
}

/**
 * @param {Array<{ satoshis: Number|BigInt }>} coins
 * @returns {bigint}
 */
function getBalance(coins) {
  let balance = 0n;
  for (let utxo of coins) {
    //@ts-ignore
    let sats = BigInt(utxo.satoshis);
    balance += sats;
  }

  return balance;
}

/**
 * @param {String} address
 * @returns {Promise<Array<TxInput>>}
 */
async function getUtxos(address) {
  let url = `${INSIGHT_BASE_URL}/addr/${address}/utxo`;
  let resp = await fetch(url);
  let insightUtxos = await readJson(resp, url);

  // convert from Insight form to standard form
  let utxos = [];
  for (let insightUtxo of insightUtxos) {
    let utxo = {
      txId: insightUtxo.txid,
      outputIndex: insightUtxo.vout,
      address: insightUtxo.address,
      script: insightUtxo.scriptPubKey,
      satoshis: insightUtxo.satoshis,
    };
    utxos.push(utxo);
  }

  return utxos;
}

/**
 * @param {Response} resp
 * @param {String} url
 */
async function readJson(resp, url) {
  let text = await resp.text();

  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    console.error(`error: could parse ${url}:`);
    console.error(text);
    throw e;
  }
  if (!resp.ok) {
    throw new Error(`bad response: ${text}`);
  }

  return data;
}

/**
 * @param {String} txHex
 */
async function instantSend(txHex) {
  // Ex:
  //   - https://insight.dash.org/insight-api-dash/tx/sendix
  //   - https://dashsight.dashincubator.dev/insight-api/tx/sendix
  let url = `${INSIGHT_BASE_URL}/tx/sendix`;
  let payload = { rawtx: txHex };
  let body = JSON.stringify(payload, null, 2);
  let resp = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: body,
  });
  let data = await readJson(resp, url);

  return data;
}

async function main() {
  // example:
  let args = process.argv.slice(2);
  let address = args[0] || "XjLxscqf1Z2heBDWXVi2YmACmU53LhtyGA";
  let amount = parseFloat(args[1]) || 0.001;
  let memoString = args[2] || "Hello, Dash!";

  await Maya.transferToDash(address, amount, memoString);
}

if (require.main === module) {
  main().catch(function (e) {
    console.error(e.stack || e);
    process.exit();
  });
}