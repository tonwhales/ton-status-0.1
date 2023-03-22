import fs from 'fs';
import { Address, TonClient, Cell } from "ton";
import { ElectorContract } from "ton-contracts";
import BN from "bn.js";
import { createBackoff } from "teslabot";
import yargs from "yargs/yargs";
import { Gauge, register } from "prom-client";
import express from "express";
import axios from "axios";

let conf = JSON.parse(fs.readFileSync('/etc/ton-status/config.json.new', 'utf-8'));
let pools = conf.pools;

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
const backoff = createBackoff({ onError: (e, i) => i > 3 && console.warn(e), maxFailureCount: 5});

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
    let result = await backoff(() => client.callGetMethod(address, method, []));;
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
    let stack = await backoff(() => callMethodReturnStack(address, 'get_proxy'));
    return addressFromStack(stack)
}

async function resolveController(address) {
    let stack = await backoff(() => callMethodReturnStack(address, 'get_controller'));
    return addressFromStack(stack)
}

async function resolveOwner(address) {
    let stack = await backoff(() => callMethodReturnStack(address, 'get_owner'));
    return addressFromStack(stack)
}

async function getConfigReliable() {
    return await backoff(() => client.services.configs.getConfigs());
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

function calculateApy(totalStake: BN, totalBonuses: BN, cycleDuration: number): string {
    const PRECISION = 1000000;
    const YEAR_SEC = 365 * 24 * 60 * 60 * 1000;
    const YEAR_CYCLES = Math.floor(YEAR_SEC / (cycleDuration * 2));
    let percentPerCycle = totalBonuses.muln(PRECISION).div(totalStake).toNumber() / PRECISION;
    let compound = Math.pow(1 + percentPerCycle, YEAR_CYCLES) - 1;
    return (compound * 100).toFixed(5);
}

function APY(startWorkTime, electionEntities, electionsHistory, bonuses, validatorsElectedFor) {
    electionEntities.sort((a, b) => new BN(b.amount).cmp(new BN(a.amount)));

    let filtered = electionsHistory.filter((v) => { return (v.id * 1000) < startWorkTime })

    return calculateApy(new BN(filtered[0].totalStake, 10), filtered[0].id * 1000 === startWorkTime ? bonuses : new BN(filtered[0].bonuses, 10), validatorsElectedFor)
}

async function fetchElections() {
    let latest = ((await axios.get('https://connect.tonhubapi.com/net/mainnet/elections/latest')).data as { elections: number[] }).elections;
    if (latest.length > 5) {
        latest = latest.slice(latest.length - 5);
    }
    return await Promise.all(latest.map(async (el) => {
        let r = (await axios.get('https://connect.tonhubapi.com/net/mainnet/elections/' + el)).data as {
            election: {
                unfreezeAt: number,
                stakeHeld: number,
                bonuses: string,
                totalStake: string
            }
        };
        return {
            id: el,
            unfreezeAt: r.election.unfreezeAt,
            stakeHeld: r.election.stakeHeld,
            bonuses: r.election.bonuses,
            totalStake: r.election.totalStake
        };
    }));
}

async function getStakingStats() {
    let elector = new ElectorContract(client);
    let electionEntitiesRaw = await (elector.getElectionEntities().then((v) => v.entities));
    let electionEntities = electionEntitiesRaw.map((v) => ({ key: v.pubkey.toString('base64'), amount: v.stake, address: v.address.toFriendly() }));
    let configs = await getConfigReliable();
    let startWorkTime = configs.validatorSets.currentValidators!.timeSince * 1000;
    let validatorsElectedFor = configs.validators.validatorsElectedFor * 1000;
    let electionsHistory = (await fetchElections()).reverse();
    let elections = await (elector.getPastElections());
    let ex = elections.find((v) => v.id === configs.validatorSets.currentValidators!.timeSince)!;
    let bonuses = new BN(0);
    if (ex) {
        bonuses = ex.bonuses;
    }
    let globalApy = parseFloat(APY(startWorkTime, electionEntities, electionsHistory, bonuses, validatorsElectedFor));
    let result = {};
    async function _getStakingStats(contractName, contractAddress) {
           var poolParamsStack = await backoff(() => callMethodReturnStack(contractAddress, 'get_params'));
           let poolFee = (new BN(poolParamsStack[5][1].slice(2), 'hex')).divn(100).toNumber();
           let poolApy = (globalApy - globalApy * (poolFee / 100)).toFixed(2);
	   let ownerAddress = await resolveOwner(contractAddress);
	   let callMethodResult = undefined;
	   let denominator = 1;
	   let share = 1;
	   try {
               callMethodResult = await client.callGetMethod(ownerAddress, 'supported_interfaces', []);
	   } catch (e) {
               // if contract does not have supported_interfaces method, it is not a DAO contract
	   }
	   if (callMethodResult) {
	       let dataCell = Cell.fromBoc((await client.getContractState(ownerAddress)).data!)[0].beginParse()
	       dataCell.readCell()
	       dataCell.readAddress();
	       dataCell.readBit();
	       let nominators = dataCell.readDict(257,  (s) => ({share: s.readUintNumber(257)}));
	       let actualDenominator = dataCell.readInt(257).toNumber();
               for (let [addrInt, actualShare] of nominators.entries()) {
                   if (Address.parseRaw("0:" + new BN(addrInt, 10).toString(16)).equals(Address.parse(conf.whalesStakingOwner))) {
		       denominator = actualDenominator;
		       share = actualShare.share;
                   }
               }
	   }

           result[contractName] = {globalApy, poolApy: parseFloat(poolApy), poolFee, daoShare: share, daoDenominator: denominator};
    }
    let promises = Object.entries(contracts).map(
            ([contractName, contractAddress]) => _getStakingStats(contractName, contractAddress)
    );
    await Promise.all(promises);

    return result
}

async function getComplaintsAddresses() {
    try {
        let configs = await getConfigReliable();
        if (!configs.validatorSets.prevValidators) {
            return {"success": false, msg: "No prevValidators field.", payload:[]}
        }
        let complaintsList = [];
	let electorContract = new ElectorContract(client);
	let elections = await backoff(() => electorContract.getPastElections());
        let complaintsValidators = configs.validatorSets.prevValidators;
        let complaintsElectionId = complaintsValidators.timeSince;
        let complaintsElections = elections.find((v) => v.id === complaintsElectionId)!;
        let complaints = await backoff(() => electorContract.getComplaints(complaintsElectionId));
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
    let configs = await getConfigReliable();
    let currentTimeInSeconds = Math.floor(Date.now() / 1000);
    const elector = new ElectorContract(client);
    let electionsId = await backoff(() => elector.getActiveElectionId());
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
        var poolStatusStack = await backoff(() => callMethodReturnStack(contractAddress, 'get_pool_status'));
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
    let elector = new ElectorContract(client);
    // https://github.com/ton-blockchain/ton/blob/24dc184a2ea67f9c47042b4104bbb4d82289fac1/crypto/smartcont/elector-code.fc#L1071
    let electionEntities = await backoff(() => elector.getElectionEntities());
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
           let proxyContractAddress = await backoff(() => resolveContractProxy(pools[pool_name].contracts[contractName]));
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
    let configs = await getConfigReliable();
    let electorContract = new ElectorContract(client);
    let elections = await backoff(() => electorContract.getPastElections());
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

async function unowned() {
    let result = {};
    async function _getUnowned (contractName, contractAddress) {
        let response = await backoff(() => client.callGetMethod(contractAddress, 'get_unowned', []));
        result[contractName] = tonFromBNStack(response.stack, 0)
    }
    let promises = Object.entries(contracts).map(
            ([contractName, contractAddress]) => _getUnowned(contractName, contractAddress)
    );
    await Promise.all(promises);

    return result
}

async function getValidatorsStats() {
    let configs = await getConfigReliable();
    let elector = new ElectorContract(client);
    let elections = await backoff(() => elector.getPastElections());
    let ex = elections.find(v => v.id === configs.validatorSets.currentValidators!.timeSince)!;
    let all = new BN(0);
    [...configs.validatorSets.currentValidators.list.values()].map(
	    (entity) => all.iadd(ex.frozen.get(new BN(entity.publicKey, 'hex').toString()).stake)
    );
    return {"quantity": configs.validatorSets.currentValidators.total, "totalStake": bnNanoTONsToTons(all)}
}

async function getNextElectionsTime() {
    let configs = await getConfigReliable();
    let startWorkTimeNext = configs.validatorSets.nextValidators?.timeSince || false;
    let startWorkTimeCurrent = configs.validatorSets.currentValidators!.timeSince;
    let elector = new ElectorContract(client);
    let startWorkTimeFromElections = await backoff(() => elector.getActiveElectionId());
    let oldStartWorkTime = startWorkTimeNext ? startWorkTimeNext : startWorkTimeCurrent
    let startWorkTime = startWorkTimeFromElections ? startWorkTimeFromElections : oldStartWorkTime
    let electorsEndBefore = configs.validators.electorsEndBefore;
    let electorsStartBefore = configs.validators.electorsStartBefore;
    let validatorsElectedFor = configs.validators.validatorsElectedFor;
    let startElection = startWorkTime - electorsStartBefore;
    let startNextElection = startElection + validatorsElectedFor;
    return startNextElection
}

async function controllersBalance() {
    let result = {};
    async function _controllersBalance (contractName, contractAddress) {
        let controllerAddress = await resolveController(contractAddress);
        let balance = await backoff(() => client.getBalance(controllerAddress));
        result[contractName] = bnNanoTONsToTons(balance);
    }
    let promises = Object.entries(contracts).map(
            ([contractName, contractAddress]) => _controllersBalance(contractName, contractAddress)
    );
    await Promise.all(promises);

    return result
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

async function exposeNextElectionsTime() {
    console.log("Updating metrics for exposeNextElectionsTime");
    let result = await getNextElectionsTime();
    consumeMetric(exposeNextElectionsTime, "nextElectionsTime", {}, result);
    console.log("Successfully updated metrics for exposeNextElectionsTime");
}

let collectFunctions = [getStakingState, timeBeforeElectionEnd, electionsQuerySent, getStake, mustParticipateInCycle, poolsSize, unowned, controllersBalance, getStakingStats];
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
    funcToMetricNames[(<any>exposeNextElectionsTime)] = [];
    exposeNextElectionsTime();
    setInterval(async function () {await exposeNextElectionsTime()}, interval);
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
    .command('get-staking-apy', "Returns statistics corresponding to erevry pool", () => {}, async () => {print(await getStakingStats())})
    .command('start-exporter', "Start metrics exporter", () => {}, async () => {await startExporter()})
    .demandCommand()
    .help('h')
    .alias('h', 'help')
    .argv;
