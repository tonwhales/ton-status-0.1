import { Address, TonClient, TonClient4, TupleItem, TupleReader, fromNano, Cell, configParse15, configParseValidatorSet, loadConfigParamById, ElectorContract4 } from "ton";
import { TupleItemInt, TupleItemCell, Dictionary } from "ton-core";
import fs from 'fs';
import 'reflect-metadata';
//import BN from "bn.js";
import { createBackoff } from "teslabot";
import { Cacheable } from 'cache-flow';
import { mutex } from 'typescript-mutex-decorator';
import express, { Express, Request, Response } from 'express';
import { Gauge, register } from "prom-client";
import axios from "axios";

const INTER_BLOCK_DELAY_SECONDS = 3;
const PROMETHEUS_PORT = 8080;

let conf = JSON.parse(fs.readFileSync('./config.json', 'utf-8'));
let pools = conf.pools;

// const lastBlockSeqnoCache = new CacheContainer(new MemoryStorage())

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

//let client = new TonClient({ endpoint: "https://mainnet.tonhubapi.com/jsonRPC"});
let v4Client = new TonClient4({ endpoint: "https://mainnet-v4.tonhubapi.com", timeout: 10000 });
const backoff = createBackoff({ onError: (e, i) => i > 3 && console.warn(e), maxFailureCount: 5 });

// function parseHex(src: string): BN {
//     if (src.startsWith('-')) {
//         let res = parseHex(src.slice(1));
//         return res.neg();
//     }
//     return new BN(src.slice(2), 'hex');
// }

type StakingState = {
    stakeAt: number;
    stakeUntil: number;
    stakeSent: bigint;
    querySent: boolean;
    couldUnlock: boolean;
    locked: boolean;
};


type TVMExecutionResult = {
    exitCode: number;
    result: TupleItem[];
    resultRaw: string | null;
    block: {
        workchain: number;
        shard: string;
        seqno: number;
        fileHash: string;
        rootHash: string;
    };
    shardBlock: {
        workchain: number;
        shard: string;
        seqno: number;
        fileHash: string;
        rootHash: string;
    };
    reader: TupleReader;
}

(BigInt.prototype as any).toJSON = function () {
    return this.toString();
};

// async function getStakingState() {
//     //let result: {string: {string: BN}} = {};
//     //let result = new Map<string, StakingState>();
//     let result = new Map<string, StakingState>();
//     async function _getStakingState (contractName: string, contractAddress: Address) {
//         let response = await backoff(() => client.callGetMethod(contractAddress, 'get_staking_status', []));
//         let stakeAt = response.stack.readNumber();
//         let stakeUntil = response.stack.readNumber();
//         let stakeSent = response.stack.readBigNumber();
//         let querySent = response.stack.readBoolean();
//         let couldUnlock = response.stack.readBoolean();
//         let locked = response.stack.readBoolean();
//        result.set(contractName, {
//             stakeAt,
//             stakeUntil,
//             stakeSent,
//             querySent,
//             couldUnlock,
//             locked
//         })
//     }
//     let promises = Object.entries(contracts).map(
//             ([contractName, contractAddress]) => _getStakingState(contractName, contractAddress)
//     );
//     await Promise.all(promises);

//     return JSON.stringify(Object.fromEntries(result));
// }

class LastBlock {
    private static instance: LastBlock;
    private constructor() { }

    public static getInstance(): LastBlock {
        if (!LastBlock.instance) {
            LastBlock.instance = new LastBlock();
        }
        return LastBlock.instance;
    }
    @mutex()
    @Cacheable({ options: { expirationTime: INTER_BLOCK_DELAY_SECONDS } })
    public async getSeqno(): Promise<number> {
        return (await backoff(() => v4Client.getLastBlock())).last.seqno
    }
}



class WrappedClient {
    public static tupleItemHash(items: TupleItem[]): string {
        let hash = "";
        if (items == undefined || items.length == 0) {
            return ""
        }
        items.forEach(item => {
            switch (item.type) {
                case 'tuple': {
                    hash += WrappedClient.tupleItemHash(item.items) + "\n";
                }
                case 'null': {
                    hash += "null\n"
                }
                case 'nan': {
                    hash += "nan\n"
                }
                case 'int': {
                    hash += (item as TupleItemInt).value.toString() + "\n";
                }
                case 'slice':
                case 'builder':
                case 'cell': {
                    hash += ((item as unknown) as TupleItemCell).cell.hash().toString('hex') + "\n"
                }
                default: {
                    throw Error('Unsupported TupleItem type');
                }
            }
        });
        return hash
    }

    @Cacheable({
        options: { expirationTime: INTER_BLOCK_DELAY_SECONDS },
        argsToKey: (address: Address, methodName: string, args?: TupleItem[]) => [address.toString(), methodName].concat([args ? WrappedClient.tupleItemHash(args) : "none"])
    })
    public static async runMethodOnLastBlock(address: Address, methodName: string, args?: TupleItem[]): Promise<TVMExecutionResult> {
        const seqno = await LastBlock.getInstance().getSeqno();
        return await backoff(() => v4Client.runMethod(seqno, address, methodName, args));
    }

    @Cacheable({
        options: { maxSize: 100 },
        argsToKey: (seqno: number, address: Address, methodName: string, args?: TupleItem[]) => [seqno, address.toString(), methodName].concat([args ? WrappedClient.tupleItemHash(args) : "none"])
    })
    public static async runMethod(seqno: number, address: Address, methodName: string, args?: TupleItem[]): Promise<TVMExecutionResult> {
        return await backoff(() => v4Client.runMethod(seqno, address, methodName, args));

    }

    @Cacheable({ options: { maxSize: 100 } })
    public static async getAccount(block: number, address: Address) {
        return await backoff(() => v4Client.getAccount(block, address));
    }

    @Cacheable({ options: { maxSize: 100 } })
    public static async getConfig(seqno: number, ids?: number[]) {
        return await backoff(() => v4Client.getConfig(seqno, ids));
    }
}


async function getStakingState() {
    const result = new Map<string, StakingState>();
    async function _getStakingState(contractName: string, contractAddress: Address) {
        const statusRes = (await WrappedClient.runMethodOnLastBlock(contractAddress, 'get_staking_status'));
        const stakingStatus = statusRes.result;
        // https://docs.ton.org/learn/tvm-instructions/tvm-exit-codes
        // 1 is !!!ALTERNATIVE!!! success exit code
        if (statusRes.exitCode === 0 || statusRes.exitCode === 1) {
            if (statusRes.result[0].type !== 'int') {
                throw Error('Invalid response');
            }
        } else {
            throw Error(`Got unexpextedexit code from get_staking_status method call: ${statusRes.exitCode}`)
        }
        const stakeAt = parseInt((stakingStatus[0] as TupleItemInt).value.toString());
        const stakeUntil = parseInt((stakingStatus[1] as TupleItemInt).value.toString());
        const stakeSent = (stakingStatus[2] as TupleItemInt).value;
        const querySent = (stakingStatus[3] as TupleItemInt).value === BigInt(-1);
        const couldUnlock = (stakingStatus[4] as TupleItemInt).value === BigInt(-1);
        const locked = (stakingStatus[5] as TupleItemInt).value === BigInt(-1);
        result.set(contractName, {
            stakeAt,
            stakeUntil,
            stakeSent,
            querySent,
            couldUnlock,
            locked
        })

    }
    const promises = Object.entries(contracts).map(
        ([contractName, contractAddress]) => _getStakingState(contractName, contractAddress)
    );
    await Promise.all(promises);

    return result;
}

function calculateApy(totalStake: bigint, totalBonuses: bigint, cycleDuration: number): string {
    const PRECISION = BigInt(1000000);
    const YEAR_SEC = 365 * 24 * 60 * 60 * 1000;
    const YEAR_CYCLES = Math.floor(YEAR_SEC / (cycleDuration * 2));
    let percentPerCycle = (totalBonuses * PRECISION) / totalStake / PRECISION;
    let compound = Math.pow(parseInt((BigInt(1) + percentPerCycle).toString()), YEAR_CYCLES) - 1;
    return (compound * 100).toFixed(5);
}

function APY(startWorkTime: number, electionEntities: { key: string, amount: bigint, address: string }[], electionsHistory, bonuses: bigint, validatorsElectedFor) {
    //electionEntities.sort((a, b) => new BN(b.amount).cmp(new BN(a.amount)));
    electionEntities.sort((a, b) => {
        if (a.amount > b.amount) {
            return 1;
        } else if (a.amount < b.amount) {
            return -1;
        } else {
            return 0;
        }
    });
    console.log('electionsHistory', electionsHistory);
    console.log('startWorkTime', startWorkTime);
    let filtered = electionsHistory.filter((v) => { return v.id < startWorkTime }).pop()
    console.log('filtered', filtered);

    return calculateApy(BigInt(filtered.totalStake), filtered.id === startWorkTime ? bonuses : BigInt(filtered.bonuses), validatorsElectedFor)
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


// class V4ToPytonAdapter {
//     public async callGetMethod(address: Address, name: string, stack?: TupleItem[]): Promise<{gas_used: number, stack: TupleReader}> {
//         const result = (await WrappedClient.runMethodOnLastBlock(address, name, stack)).result
//         return new Promise(() => ({stack: result, gas_used: 0}))
//     }
// }

// const pytonEmulatedClient = new V4ToPytonAdapter()

async function resolveOwner(address: Address) {
    const res = (await WrappedClient.runMethodOnLastBlock(address, 'get_owner')).result.pop();
    if (res.type === "slice") {
        return res.cell.beginParse().loadAddress();
    }
    throw Error('Got invalid return type from get_owner method of: ' + address.toString());
}

async function getStakingStats() {
    const seqno = await LastBlock.getInstance().getSeqno();
    //let elector = new ElectorContract((pytonEmulatedClient as TonClient));
    // past_elections tested and works ok during elections on testnet
    const elector = new ElectorContract4((WrappedClient as unknown) as TonClient4);
    console.log("elector.getElectionEntities(seqno)", await elector.getElectionEntities(seqno));
    let electionEntitiesRaw = (await (elector.getElectionEntities(seqno)) || {entities: []}).entities;
    let electionEntities = electionEntitiesRaw.map((v) => ({ key: v.pubkey.toString('base64'), amount: v.stake, address: v.address.toString() }));
    //let configs = await getConfigReliable();
    const srializedConfigCell = (await WrappedClient.getConfig(seqno, [15, 34])).config.cell;
    const config15 = configParse15(loadConfigParamById(srializedConfigCell, 15).beginParse());
    const config32 = configParseValidatorSet(loadConfigParamById(srializedConfigCell, 34).beginParse());
    //let startWorkTime = configs.validatorSets.currentValidators!.timeSince * 1000;
    let startWorkTime = config32.timeSince;
    //let validatorsElectedFor = configs.validators.validatorsElectedFor * 1000;
    let validatorsElectedFor = config15.validatorsElectedFor * 1000;
    let electionsHistory = (await fetchElections()).reverse();
    let elections = await (elector.getPastElections(seqno));
    let ex = elections.find((v) => v.id === startWorkTime)!;
    let bonuses = BigInt(0);
    if (ex) {
        bonuses = ex.bonuses;
    }
    let globalApy = parseFloat(APY(startWorkTime, electionEntities, electionsHistory, bonuses, validatorsElectedFor));
    let result = {};
    async function _getStakingStats(contractName: string, contractAddress: Address) {
        //var poolParamsStack = await backoff(() => callMethodReturnStack(contractAddress, 'get_params'));
        var poolParamsStack = (await WrappedClient.runMethodOnLastBlock(contractAddress, 'get_params')).result;
        let poolFee = parseInt(((poolParamsStack[5] as TupleItemInt).value / BigInt(100)).toString());
        let poolApy = (globalApy - globalApy * (poolFee / 100)).toFixed(2);
        let ownerAddress = await resolveOwner(contractAddress);
        let callMethodResult: TVMExecutionResult = undefined;
        let denominator = 1;
        let share = 1;
        //callMethodResult = await client.callGetMethod(ownerAddress, 'supported_interfaces', []);
        callMethodResult = await WrappedClient.runMethodOnLastBlock(ownerAddress, 'supported_interfaces');
        if (callMethodResult.exitCode === 0 || callMethodResult.exitCode === 1) {
            //let dataCell = Cell.fromBoc((await client.getContractState(ownerAddress)).data!)[0].beginParse()
            const account = await WrappedClient.getAccount(seqno, ownerAddress);
            if (account.account.state.type != "active") {
                throw Error(`Got invalid account state: ${account.account.state.type} address: ${ownerAddress.toString()}`);
            }
            //console.log(contractName, Cell.fromBase64(account.account.state.data));
            const data = Cell.fromBase64(account.account.state.data).beginParse()
            data.loadRef();
            data.loadAddress();
            //data.loadBit();
            //let nominators = data.readDict(257, (s) => ({ share: s.readUintNumber(257) }));
            const nominators = data.loadDict(Dictionary.Keys.BigUint(257), Dictionary.Values.Uint(257));
            //let actualDenominator = data.readInt(257).toNumber();
            let actualDenominator = data.loadInt(257);
            for (let [addrInt, actualShare] of nominators) {
                if (Address.parseRaw("0:" + BigInt(addrInt).toString(16)).equals(Address.parse(conf.whalesStakingOwner))) {
                    denominator = actualDenominator;
                    share = actualShare;
                }
            }
        }

        result[contractName] = { globalApy, poolApy: parseFloat(poolApy), poolFee, daoShare: share, daoDenominator: denominator };
    }
    let promises = Object.entries(contracts).map(
        ([contractName, contractAddress]) => _getStakingStats(contractName, contractAddress)
    );
    await Promise.all(promises);

    return result
}


//  -------------------------------

// function bnNanoTONsToTons(bn: BN): number {
//     return bn.div(new BN(Math.pow(10, 9))).toNumber()
// }

function valueToInt(value: bigint | boolean): number {
    // if (value instanceof BN) {
    //     return bnNanoTONsToTons(value);
    // }
    switch (typeof value) {
        case "bigint":
            return parseInt(fromNano(value))
        case "boolean":
            return value ? 1 : 0;
        case "number":
            return value
        default:
            throw Error('Unsupported type:' + String(typeof value))
    }
}

const toCamel = (s: string): string => {
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

function consumeMetric(func, metricName: string, poolLabel, value) {
    let sanitizedMetricName = toCamel(metricName);
    memoizeMetric(func, sanitizedMetricName);
    let labelNames = Object.keys(poolLabel);
    if (sanitizedMetricName in register["_metrics"]) {
        let gauge = register["_metrics"][sanitizedMetricName];
        let mutableGauge = labelNames ? gauge.labels(poolLabel) : gauge;
        mutableGauge.set(valueToInt(value));
    } else {
        const gauge = new Gauge({ name: sanitizedMetricName, help: 'h', labelNames: labelNames });
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
        console.log(result);
    }
    catch (e) {
        console.log("Got error during execution of", func.name, "func. Error:", e)
        deleteMetrics(func);
        return
    }
    if (!(func in funcToMetricNames)) {
        funcToMetricNames[func] = [];
    }
    //for (const [poolName, obj] of Object.entries(result)) {
    for (const [poolName, obj] of result.entries()) {
        console.log("iterating")
        let poolLabel = { pool: poolName.toLowerCase().replace(/#/g, '').replace(/ /g, '_') };
        if (['number', 'boolean'].includes(typeof obj)) {
            console.log("here");
            consumeMetric(func, func.name, poolLabel, obj);
            continue
        }
        for (let [metricName, value] of Object.entries(obj)) {
            console.log("here2");
            consumeMetric(func, metricName, poolLabel, value);
        }
    }
    console.log("Successfully updated metrics for", func.name);
}

// async function exposeComplaints() {
//     console.log("Updating metrics for exposeComplaints");
//     let result = await getComplaintsAddresses();
//     if (result.success && result.payload.length != 0) {
//         consumeMetric(exposeComplaints, "complaintReceived", {}, 1);
//         console.log("Successfully updated metrics for exposeComplaints");
//         return
//     }
//     consumeMetric(exposeComplaints, "complaintReceived", {}, 0);
//     console.log("Successfully updated metrics for exposeComplaints");
// }

// async function exposeValidatorsStats() {
//     console.log("Updating metrics for exposeValidatorsStats");
//     let result = await getValidatorsStats();
//     consumeMetric(exposeValidatorsStats, "currentValidatorsQuantity", {}, result.quantity);
//     consumeMetric(exposeValidatorsStats, "currentValidatorsTotalStake", {}, result.totalStake);
//     console.log("Successfully updated metrics for exposeValidatorsStats");
// }

// async function exposeNextElectionsTime() {
//     console.log("Updating metrics for exposeNextElectionsTime");
//     let result = await getNextElectionsTime();
//     consumeMetric(exposeNextElectionsTime, "nextElectionsTime", {}, result);
//     console.log("Successfully updated metrics for exposeNextElectionsTime");
// }

let collectFunctions = [getStakingState];//, timeBeforeElectionEnd, electionsQuerySent, getStake, mustParticipateInCycle, poolsSize, unowned, controllersBalance, getStakingStats];
let seconds = 15;
let interval = seconds * 1000;

async function startExporter() {
    const app: Express = express();
    for (let func of collectFunctions) {
        exposeMetrics(func);
        setInterval(async function () { await exposeMetrics(func) }, interval);
    }
    // funcToMetricNames[(<any>exposeComplaints)] = [];
    // exposeComplaints();
    // setInterval(async function () {await exposeComplaints()}, interval);
    // funcToMetricNames[(<any>exposeValidatorsStats)] = [];
    // exposeValidatorsStats();
    // setInterval(async function () {await exposeValidatorsStats()}, interval);
    // funcToMetricNames[(<any>exposeNextElectionsTime)] = [];
    // exposeNextElectionsTime();
    // setInterval(async function () {await exposeNextElectionsTime()}, interval);
    app.get('/metrics', async (req: Request, res: Response) => {
        res.setHeader('Content-Type', register.contentType);
        res.send(await register.metrics());
    });
    process.on('uncaughtException', function (err) {
        console.log('Caught exception: ', err);
    });
    process.on('unhandledRejection', function (err) {
        console.log('Caught exception: ', err);
    });

    app.listen(PROMETHEUS_PORT, () => console.log(`Server is running on http://localhost:${PROMETHEUS_PORT}, metrics are exposed on http://localhost:${PROMETHEUS_PORT}/metrics`));
}


async function main() {
    //await startExporter();
    console.log(await getStakingStats());
    //console.log(await getStakingState());
    // console.log(await _getStakingState());
    // console.log("start")
    // await WrappedClient.runMethodOnLastBlock(Address.parse("EQDhGXtbR6ejNQucRcoyzwiaF2Ke-5T8reptsiuZ_mLockup"), 'get_staking_status')
    // console.log("finish")
}

main()