import fs from 'fs';
import { Address, TonClient, Cell } from "ton";
import { ElectorContract } from "ton-contracts";
import BN from "bn.js";
import { createBackoff } from "teslabot";
import yargs from "yargs/yargs";
import { Gauge, register } from "prom-client";
import express from "express";

let pools = JSON.parse(fs.readFileSync('/etc/ton-status/config.json.new', 'utf-8')).pools
interface Contracts {
  [name: string]: Address;
}
let contracts: Contracts = {};
for (const pool_name of Object.keys(pools)) {
    for (const contractName of Object.keys(pools[pool_name].contracts)) {
        pools[pool_name].contracts[contractName] = Address.parse(pools[pool_name].contracts[contractName]);
        contracts[contractName] = pools[pool_name].contracts[contractName];
    }
}

let client = new TonClient({ endpoint: "https://mainnet.tonhubapi.com/jsonRPC"});
const backoff = createBackoff({ onError: (e, i) => i > 3 && console.warn(e) });

//utils section

function parseHex(src: string): BN {
    if (src.startsWith('-')) {
        let res = parseHex(src.slice(1));
        return res.neg();
    }
    return new BN(src.slice(2), 'hex');
}

function bnNanoTONsToTons(bn: BN): number {
    return bn.div(new BN(Math.pow(10, 9))).toNumber()
}

async function callMethodReturnStack(address, method) {
    let result = await client.callGetMethod(address, method, []);
    return result.stack
}

function tonFromBNStack(stack, frameNumber) {
    let bn = new BN(stack[frameNumber][1].slice(2), 'hex');
    return bnNanoTONsToTons(bn)
}

function addressFromStack(stack) {
    let cell = Cell.fromBoc(Buffer.from(stack[0][1].bytes, 'base64'))[0];
    let slice = cell.beginParse();
    return slice.readAddress()
}

async function resolveContractProxy(address) {
    let stack = await callMethodReturnStack(address, 'get_proxy');
    return addressFromStack(stack)
}

// payload section

async function getStakingState() {
    let result = {};
    async function _getStakingState (contractName, contractAddress) {
        let response = await backoff(() => client.callGetMethod(contractAddress, 'get_staking_status', []));
        let stakeAt =     parseHex(response.stack[0][1] as string).toNumber();
        let stakeUntil =  parseHex(response.stack[1][1] as string).toNumber();
        let stakeSent =   parseHex(response.stack[2][1] as string);
        let querySent =   parseHex(response.stack[3][1] as string).toNumber() === -1;
        let couldUnlock = parseHex(response.stack[4][1] as string).toNumber() === -1;
        let locked =      parseHex(response.stack[5][1] as string).toNumber() === -1;
       result[contractName] = {
            stakeAt,
            stakeUntil,
            stakeSent,
            querySent,
            couldUnlock,
            locked
        }
    }
    let promises = Object.entries(contracts).map(
            ([contractName, contractAddress]) => _getStakingState(contractName, contractAddress)
    );
    await Promise.all(promises);

    return result
}

async function getComplaintsAddresses() {
    try {
        let configs = await client.services.configs.getConfigs();
        if (!configs.validatorSets.prevValidators) {
            return {"success": false, msg: "No prevValidators field.", payload:[]}
        }
        let complaintsList = [];
        let elections = await new ElectorContract(client).getPastElections();
        let complaintsValidators = configs.validatorSets.prevValidators;
        let complaintsElectionId = complaintsValidators.timeSince;
        let complaintsElections = elections.find((v) => v.id === complaintsElectionId)!;
        let complaints = await new ElectorContract(client).getComplaints(complaintsElectionId);
       let contractAdresses = Object.values(contracts).map((addr) => addr.toFriendly());
        for (let c of complaints) {
            let address = complaintsElections.frozen.get(new BN(c.publicKey, 'hex').toString())!.address.toFriendly();
           if (contractAdresses.includes(address)) {
                complaintsList.push(address);
            }
        }
        return {"success": true, msg: "", payload: complaintsList}

    }
    catch(e) {
       return {"success": false, msg: "Execution failed: " + (e as any).message, payload:[]}
    }
}

async function timeBeforeElectionEnd() {
    let configs = await client.services.configs.getConfigs()
    let currentTimeInSeconds = Math.floor(Date.now() / 1000);
    const elector = new ElectorContract(client);
    let electionsId = await elector.getActiveElectionId();
    var timeBeforeElectionsEnd: number;
    if (electionsId) {
        timeBeforeElectionsEnd = electionsId - configs.validators.electorsEndBefore - currentTimeInSeconds;
    }
    else {
        timeBeforeElectionsEnd = 86400;
    }
    let result = {};
    for (const contractName of Object.keys(contracts)) {
        result[contractName] = timeBeforeElectionsEnd;
    }

    return result
}

async function getStake() {
    let result = {};
    async function _getStake(contractName, contractAddress){
        var poolStatusStack = await callMethodReturnStack(contractAddress, 'get_pool_status');
        let ctx_balance =                  tonFromBNStack(poolStatusStack, 0);
        let ctx_balance_pending_deposits = tonFromBNStack(poolStatusStack, 2);
        let steak_for_next_elections =     ctx_balance + ctx_balance_pending_deposits;
        result[contractName] = {
               "ctx_balance":                   ctx_balance,
                "ctx_balance_sent":             tonFromBNStack(poolStatusStack, 1),
                "ctx_balance_pending_deposits": ctx_balance_pending_deposits,
                "ctx_balance_pending_withdraw": tonFromBNStack(poolStatusStack, 3),
                "ctx_balance_withdraw":         tonFromBNStack(poolStatusStack, 4),
                "steak_for_next_elections":     steak_for_next_elections,
       }
    }
    let promises = Object.entries(contracts).map(
            ([contractName, contractAddress]) => _getStake(contractName, contractAddress)
    );
    await Promise.all(promises);

    return result
}

async function electionsQuerySent() {
    let result = {};
    let elector = await new ElectorContract(client);
    // https://github.com/ton-blockchain/ton/blob/24dc184a2ea67f9c47042b4104bbb4d82289fac1/crypto/smartcont/elector-code.fc#L1071
    let electionEntities = await elector.getElectionEntities();
    let stakes = await getStake();
    if (electionEntities.entities.length == 0) {
       for (const pool_name of Object.keys(pools)) {
           for (const contractName of Object.keys(pools[pool_name].contracts)) {
                result[contractName] = false;
            }
       }
       return result;
    }
    let querySentForADNLs = new Map<string, string>();
    for (let entitie of electionEntities.entities) {
        querySentForADNLs[entitie.adnl.toString('hex')] = entitie.address.toFriendly();
    }

    async function _electionsQuerySent(pool_name, contractName) {
           let proxyContractAddress = await resolveContractProxy(pools[pool_name].contracts[contractName]);
           let contractStake = stakes[contractName];
           let maxStake = pools[pool_name].maxStake;
           let validatorsNeeded = Math.ceil(contractStake.ctx_balance / maxStake);
           let quesrySentForNCurrentElectors = 0;
           for (let ADNL of pools[pool_name].ADNLs) {
               if (Object.keys(querySentForADNLs).includes(ADNL.toLowerCase())) {
                   if (querySentForADNLs[ADNL.toLowerCase()] == proxyContractAddress.toFriendly()) {
                       quesrySentForNCurrentElectors++;
                   }
               }
           }
           if (validatorsNeeded > quesrySentForNCurrentElectors) {
               result[contractName] = false;
           }
           else {
               result[contractName] = true;
           }
    }

    let promises = [];
    for (const pool_name of Object.keys(pools)) {
        for (const contractName of Object.keys(pools[pool_name].contracts)) {
            promises.push(_electionsQuerySent(pool_name, contractName))
        }
    }
    await Promise.all(promises)

    return result
}

async function mustParticipateInCycle() {
    let configs = await client.services.configs.getConfigs();
    let elections = await new ElectorContract(client).getPastElections();
    let ex = elections.find(v => v.id === configs.validatorSets.currentValidators!.timeSince)!;
    let validatorProxyAddresses = [];
    for (let key of configs.validatorSets.currentValidators!.list!.keys()) {
        let val = configs.validatorSets.currentValidators!.list!.get(key)!;
        let v = ex.frozen.get(new BN(val.publicKey, 'hex').toString());
        validatorProxyAddresses.push(v.address.toFriendly());
    }

    let result = {};
    async function _mustParticipateInCycle(contractName, contractAddress) {
        let proxyContractAddress = await resolveContractProxy(contractAddress);
        if (validatorProxyAddresses.includes(proxyContractAddress.toFriendly())) {
            result[contractName] = false;
        }
        else {
            result[contractName] = true;
        }
    }
    let promises = Object.entries(contracts).map(
            ([contractName, contractAddress]) => _mustParticipateInCycle(contractName, contractAddress)
    );
    await Promise.all(promises);

    return result
}

async function poolsSize() {
    let result = {};
    for (const pool_name of Object.keys(pools)) {
        for (const contractName of Object.keys(pools[pool_name].contracts)) {
           result[contractName] = pools[pool_name].ADNLs.length
        }
    }
    return result
}

async function getValidatorsStats() {
    let configs = await client.services.configs.getConfigs();
    let elector = new ElectorContract(client);
    let elections = await elector.getPastElections();
    let ex = elections.find(v => v.id === configs.validatorSets.currentValidators!.timeSince)!;
    let all = new BN(0);
    [...configs.validatorSets.currentValidators.list.values()].map(
	    (entity) => all.iadd(ex.frozen.get(new BN(entity.publicKey, 'hex').toString()).stake)
    );
    return {"quantity": configs.validatorSets.currentValidators.total, "totalStake": bnNanoTONsToTons(all)}
}

// metrics section

function valueToInt(value) {
    if (value instanceof BN) {
        value = bnNanoTONsToTons(value);
    }
    if (typeof value == "boolean") {
        value = value ? 1 : 0;
    }
    return value
}

const toCamel = (s) => {
  return s.replace(/([-_][a-z])/ig, ($1) => {
    return $1.toUpperCase()
      .replace('-', '')
      .replace('_', '');
  });
};

let funcToMetricNames = {};
function memoizeMetric(func, metric) {
    if (funcToMetricNames[func].indexOf(metric) === -1) {
        funcToMetricNames[func].push(metric);
    }
}

function consumeMetric(func, metricName, poolLabel, value) {
    let sanitizedMetricName = toCamel(metricName);
    memoizeMetric(func, sanitizedMetricName);
    let labelNames = Object.keys(poolLabel);
    if (sanitizedMetricName in register["_metrics"]) {
        let gauge = register["_metrics"][sanitizedMetricName];
        let mutableGauge = labelNames ? gauge.labels(poolLabel) : gauge;
        mutableGauge.set(valueToInt(value));
    } else {
        const gauge = new Gauge({ name: sanitizedMetricName, help: 'h', labelNames: labelNames});
        let mutableGauge = labelNames ? gauge.labels(poolLabel) : gauge
        mutableGauge.set(valueToInt(value));
    }
}

function deleteMetrics(func) {
    for (let metricName of funcToMetricNames[func]) {
        if (metricName in register["_metrics"]) {
            console.log("Delteting ", metricName, " metric.");
            delete register["_metrics"][metricName];
        }
    }
}

async function exposeMetrics(func) {
    console.log("Updating metrics for", func.name);
    let result = undefined;
    try {
        result = await func();
    }
    catch (e) {
        console.log("Got error during execution of", func.name, "func. Error:", e)
        deleteMetrics(func);
        return
    }
    if (!(func in funcToMetricNames)) {
        funcToMetricNames[func] = [];
    }
    for (const [poolName, obj] of Object.entries(result)) {
        let poolLabel = {pool: poolName.toLowerCase().replace(/#/g, '').replace(/ /g, '_')};
        if (['number', 'boolean'].includes(typeof obj)) {
            consumeMetric(func, func.name, poolLabel, obj);
            continue
        }
        for (let [metricName, value] of Object.entries(obj)) {
            consumeMetric(func, metricName, poolLabel, value);
        }
    }
    console.log("Successfully updated metrics for", func.name);
}

async function exposeComplaints() {
    console.log("Updating metrics for exposeComplaints");
    let result = await getComplaintsAddresses();
    if (result.success && result.payload.length != 0) {
        consumeMetric(exposeComplaints, "complaintReceived", {}, 1);
        console.log("Successfully updated metrics for exposeComplaints");
        return
    }
    consumeMetric(exposeComplaints, "complaintReceived", {}, 0);
    console.log("Successfully updated metrics for exposeComplaints");
}

async function exposeValidatorsStats() {
    console.log("Updating metrics for exposeValidatorsStats");
    let result = await getValidatorsStats();
    consumeMetric(exposeValidatorsStats, "currentValidatorsQuantity", {}, result.quantity);
    consumeMetric(exposeValidatorsStats, "currentValidatorsTotalStake", {}, result.totalStake);
    console.log("Successfully updated metrics for exposeValidatorsStats");
}

let collectFunctions = [getStakingState, timeBeforeElectionEnd, electionsQuerySent, getStake, mustParticipateInCycle, poolsSize];
let seconds = 15;
let interval = seconds * 1000;

async function startExporter() {
    const app = express();
    for (let func of collectFunctions) {
        exposeMetrics(func);
        setInterval(async function () {await exposeMetrics(func)}, interval);
    }
    funcToMetricNames[(<any>exposeComplaints)] = [];
    exposeComplaints();
    setInterval(async function () {await exposeComplaints()}, interval);
    funcToMetricNames[(<any>exposeValidatorsStats)] = [];
    exposeValidatorsStats();
    setInterval(async function () {await exposeValidatorsStats()}, interval);
    app.get('/metrics', async (req, res) => {
        res.setHeader('Content-Type', register.contentType);
        res.send(await register.metrics());
    });
    process.on('uncaughtException', function (err) {
        console.log('Caught exception: ', err);
    });
    process.on('unhandledRejection', function (err) {
        console.log('Caught exception: ', err);
    });

    app.listen(8080, () => console.log('Server is running on http://localhost:8080, metrics are exposed on http://localhost:8080/metrics'));
}



function print(msg: any) {
    process.stdout.write(JSON.stringify(msg) + "\n");
}

yargs(process.argv.slice(2))
    .usage('Usage: $0 <command>')
    .command('complaints', 'Get validator complaints', () => {}, async () => {print(await getComplaintsAddresses())})
    .command('staking', 'Get status of stakes', () => {}, async () => {print(await getStakingState())})
    .command('election-ends-in', 'Seconds before elections end or 86400 if no elections active', () => {}, async () => {print(await timeBeforeElectionEnd())})
    .command('get-stake', "Returns detailed information about stake status", () => {}, async () => {print(await getStake())})
    .command('election-queries-sent', "Checks if elections query for current ellections has been sent", () => {}, async () => {print(await electionsQuerySent())})
    .command('must-participate-in-cycle', "For old logic with participation in every second cycle", () => {}, async () => {print(await mustParticipateInCycle())})
    .command('get-pools-size', "Returns quantity of validators in corresponding pool", () => {}, async () => {print(await poolsSize())})
    .command('start-exporter', "Start metrics exporter", () => {}, async () => {await startExporter()})
    .demandCommand()
    .help('h')
    .alias('h', 'help')
    .argv;
