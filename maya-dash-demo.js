"use strict";

let Maya = module.exports;

let DashPhrase = require("dashphrase");
let DashHd = require("dashhd");
let DashKeys = require("dashkeys");
let DashTx = require("dashtx");
//@ts-ignore
let dashTx = DashTx.create({});

const INSIGHT_BASE_URL = "https://insight.dash.org/insight-api";

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
Maya.transferDash = async function (address, amount, memo = "") {
  console.log();

  let txInfoSigned = await Maya.createDashTransaction(address, amount, memo);
  console.log(`[DEBUG] signed tx info:`);
  console.log(txInfoSigned);
  console.log();

  let txHex = txInfoSigned.transaction.toString();
  console.log(`[DEBUG] raw transaction:`);
  console.log(txHex);
  console.log();

  console.log(`[DEBUG] inspect at https://live.blockcypher.com/dash/decodetx/`);
  console.log();

  // UNCOMMENT BELOW TO SEND FOR REAL

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
  let memoHex = DashTx.utils.strToHex(memo);

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
  let primaryPkhBytes = await DashKeys.addrToPkh(primaryAddress);
  let primaryPkh = DashKeys.utils.bytesToHex(primaryPkhBytes);
  console.log(`[DEBUG] primaryAddress:`, primaryAddress, primaryPkh);

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
  let changeOutput = { pubKeyHash: primaryPkh, satoshis: 0 };
  let txInfo = await DashTx.createLegacyTx(coins, outputs, changeOutput);
  console.log(`[DEBUG] transaction:`);
  console.log(txInfo);
  console.log();

  let change = txInfo.outputs[txInfo.changeIndex];
  console.log(`[DEBUG] change:`);
  console.log(change);
  console.log();

  // sign the transaction
  let signOpts = {
    getPrivateKey: function (input, i) {
      console.log("DEBUG input", input);
      return addressKey.privateKey;
    },
  };
  let txInfoSigned = await dashTx.hashAndSignAll(txInfo, signOpts);

  return txInfoSigned;
};

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
  // doesn't allow newlines
  let body = JSON.stringify(payload);
  let req = {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: body,
  };
  let resp = await fetch(url, req);
  let data = await readJson(resp, url);

  return data;
}

async function main() {
  // example:
  let args = process.argv.slice(2);
  let address = args[0] || "XjLxscqf1Z2heBDWXVi2YmACmU53LhtyGA";
  let amount = parseFloat(args[1]) || 0.001;
  let memoString = args[2] || "🧧";

  await Maya.transferDash(address, amount, memoString);
}

if (require.main === module) {
  main().catch(function (e) {
    console.error(e.stack || e);
    process.exit(1);
  });
}
