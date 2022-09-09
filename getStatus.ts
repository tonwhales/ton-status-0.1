import fs from 'fs';
import { Address, TonClient, TonClient4, Traits, ADNLAddress, TupleSlice4 } from "ton";
import { createExecutorFromRemote } from "ton-nodejs";
import { ElectorContract } from "ton-contracts";
import BN from "bn.js";
import { createBackoff } from "teslabot";
import yargs from "yargs/yargs";
import { Gauge, Registry } from "prom-client";
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
let v4Client = new TonClient4({endpoint: "https://mainnet-v4.tonhubapi.com"});

const backoff = createBackoff({ onError: (e, i) => i > 3 && console.warn(e) });

function parseHex(src: string): BN {
    if (src.startsWith('-')) {
        let res = parseHex(src.slice(1));
        return res.neg();
    }
    return new BN(src.slice(2), 'hex');
}

async function getStakingState() {
    let result = {};
    for (const [contractName, contractAddress] of Object.entries(contracts)) {
        let response = await backoff(() => client.callGetMethod(contractAddress, 'get_staking_status', []));
        let stakeAt = parseHex(response.stack[0][1] as string).toNumber();
        let stakeUntil = parseHex(response.stack[1][1] as string).toNumber();
        let stakeSent = parseHex(response.stack[2][1] as string);
        let querySent = parseHex(response.stack[3][1] as string).toNumber() === -1;
        let couldUnlock = parseHex(response.stack[4][1] as string).toNumber() === -1;
        let locked = parseHex(response.stack[5][1] as string).toNumber() === -1;
       result[contractName] = {
            stakeAt,
            stakeUntil,
            stakeSent,
            querySent,
            couldUnlock,
            locked
        }
    }

    return result
}

interface getComplaintsAddressesResult {
    success: boolean;
    msg: string;
    payload: string[];
}

async function getComplaintsAddresses(): Promise<getComplaintsAddressesResult> {
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
    for (const [contractName, contractAddress] of Object.entries(contracts)) {
        result[contractName] = timeBeforeElectionsEnd;
    }

    return result
}

function bnNanoTONsToTons(bn: BN): number {
    return bn.div(new BN('1000000000', 10)).toNumber()
}

async function getStake(){
    const block = (await v4Client.getLastBlock()).last.seqno;
    let result = {};
    for (const [contractName, contractAddress] of Object.entries(contracts)) {
       let executor = await createExecutorFromRemote(v4Client, block, contractAddress);
        let status = (await executor.get('get_pool_status'));
        let ctx_balance =                  bnNanoTONsToTons(status.stack.readBigNumber());
        let ctx_balance_sent =             bnNanoTONsToTons(status.stack.readBigNumber());
        let ctx_balance_pending_deposits = bnNanoTONsToTons(status.stack.readBigNumber());
        let ctx_balance_pending_withdraw = bnNanoTONsToTons(status.stack.readBigNumber());
        let ctx_balance_withdraw =         bnNanoTONsToTons(status.stack.readBigNumber());
        let steak_for_next_elections =     ctx_balance + ctx_balance_pending_deposits;
        result[contractName] = {
               "ctx_balance": ctx_balance,
                "ctx_balance_sent": ctx_balance_sent,
                "ctx_balance_pending_deposits": ctx_balance_pending_deposits,
                "ctx_balance_pending_withdraw": ctx_balance_pending_withdraw,
                "ctx_balance_withdraw": ctx_balance_withdraw,
                "steak_for_next_elections": steak_for_next_elections,
       }
    }
    return result
}

async function electionsQuerySent() {
    let result = {};
    const block = (await v4Client.getLastBlock()).last.seqno;
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

    for (const pool_name of Object.keys(pools)) {
        for (const contractName of Object.keys(pools[pool_name].contracts)) {
            const electorExecutor = await createExecutorFromRemote(v4Client, block, pools[pool_name].contracts[contractName]);
            let proxyContractAddress = (await electorExecutor.get('get_proxy')).stack.readAddress()!;
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
    }
    return result
}

async function mustParticipateInCycle() {
    let configs = await client.services.configs.getConfigs();
    const block = (await v4Client.getLastBlock()).last.seqno;
    let currentValidatorADNLs = Array.from(configs.validatorSets.currentValidators.list.values()).map(a => a.adnlAddress.toString("hex"));
    let elections = await new ElectorContract(client).getPastElections();
    let ex = elections.find(v => v.id === configs.validatorSets.currentValidators!.timeSince)!;
    let validatorProxyAddresses = [];
    for (let key of configs.validatorSets.currentValidators!.list!.keys()) {
        let val = configs.validatorSets.currentValidators!.list!.get(key)!;
       let v = ex.frozen.get(new BN(val.publicKey, 'hex').toString());
       validatorProxyAddresses.push(v.address.toFriendly());
    }

    let result = {};
    for (const [contractName, contractAddress] of Object.entries(contracts)) {
       const electorExecutor = await createExecutorFromRemote(v4Client, block, contractAddress);
        let proxyContractAddress = (await electorExecutor.get('get_proxy')).stack.readAddress()!;
       if (validatorProxyAddresses.includes(proxyContractAddress.toFriendly())) {
           result[contractName] = false;
       }
       else {
           result[contractName] = true;
       }
    }
    return result
}

async function getPoolsSize() {
    let result = {};
    for (const pool_name of Object.keys(pools)) {
        for (const contractName of Object.keys(pools[pool_name].contracts)) {
           result[contractName] = pools[pool_name].ADNLs.length
        }
    }
    return result
}

const shallowEq = (obj1, obj2) =>
  Object.keys(obj1).length === Object.keys(obj2).length &&
  Object.keys(obj1).every(key => obj1[key] === obj2[key]);

function unsetGauge(registry, metric_name, labels) {
    for (const [key, current_labels] of Object.entries(registry["_metrics"][metric_name]["hashMap"])) {
       //console.log("comaparing", current_labels["labels"], labels)
        if (shallowEq(current_labels["labels"], labels)) {
           //console.log("deleting")
           delete registry["_metrics"][metric_name]["hashMap"][key]
       }
    }
}

function valueToInt(value) {
    if (value instanceof BN) {
        value = value.div(new BN(Math.pow(10, 9))).toNumber()
    }
    if (typeof value == "boolean") {
        value = value ? 1 : 0;
    }
    return value
}

let funcToMetricNames = {};
function memoizeMetric(func, metric) {
    if (funcToMetricNames[func].indexOf(metric) === -1) {
        funcToMetricNames[func].push(metric);
    }
}

function consumeMetric(register, func, metricName, poolName, value) {
    memoizeMetric(func, metricName);
    let poolNameSanitized = poolName.toLowerCase().replaceAll("#", "").replaceAll(" ", "_")
    if (metricName in register["_metrics"]) {
        let gauge = register["_metrics"][metricName];
        gauge.labels({ pool: poolNameSanitized}).set(valueToInt(value));
    } else {
        const gauge = new Gauge({ name: metricName, help: 'h', labelNames: ['pool']});
        gauge.labels({ pool: poolNameSanitized}).set(valueToInt(value));
        register.registerMetric(gauge);
    }
}

async function exposeMetrics(func, register) {
    let result = undefined;
    try {
        result = await func();
    }
    catch (e) {
       console.log("Got error during execution of ", func.name, "func. Error: ", e)
       for (let metricName of funcToMetricNames[func]) {
           if (metricName in register["_metrics"]) {
               console.log("Delteting ", metricName, " metric.")
                delete register["_metrics"][metricName]
           }
        }
       return
    }
    if (!(func in funcToMetricNames)) {
        funcToMetricNames[func] = [];
    }
    for (const [poolName, obj] of Object.entries(result)) {
       if (['number', 'boolean'].includes(typeof obj)) {
           consumeMetric(register, func, func.name, poolName, obj)
           continue
       }
        for (let [metricName, value] of Object.entries(obj)) {
           consumeMetric(register, func, metricName, poolName, value)
       }
    }
}


let collectFunctions = [getStakingState, timeBeforeElectionEnd, electionsQuerySent, getStake, mustParticipateInCycle];
let seconds = 15;
let interval = seconds * 1000;

async function startExporter() {
    //const gauge = new Gauge({ name: 'metric_name', help: 'nohelp', labelNames: ['method', 'statusCode']});
    //gauge.set(10); // Set to 10
    const register = new Registry();
    //gauge.labels({ method: 'GET', statusCode: '200' }).set(100);
    //gauge.labels({ method: 'GET', statusCode: '300' }).set(20);
    //register.registerMetric(gauge);
    //await register.metrics()
    //unsetGauge(register, 'metric_name', { method: 'GET', statusCode: '300' });
    //delete register._metrics["metric_name"]
    const app = express();

    await exposeMetrics(getStakingState, register);
    //console.log(await getTimeBeforeElectionEnd());
    //console.log(await getStakingState());
    //console.log(await electionsQuerySent());
    await exposeMetrics(timeBeforeElectionEnd, register);
    await exposeMetrics(electionsQuerySent, register);
    await exposeMetrics(getStake, register);
    await exposeMetrics(mustParticipateInCycle, register);
    console.log(funcToMetricNames);
    

    for (let func of collectFunctions) {
        setInterval(func, interval);
    }
    app.get('/metrics', async (req, res) => {
        res.setHeader('Content-Type', register.contentType);
        res.send(await register.metrics());
    });
    process.on('uncaughtException', function (err) {
        console.log('Caught exception: ', err);
    });
    process.on('unhandledrejection', function (err) {
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
    .command('get-pools-size', "Returns quantity of validators in corresponding pool", () => {}, async () => {print(await getPoolsSize())})
    .command('start-exporter', "Start metrics exporter", () => {}, async () => {print(await startExporter())})
    .demandCommand()
    .help('h')
    .alias('h', 'help')
    .argv;

