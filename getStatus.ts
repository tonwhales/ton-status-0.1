import { Address, TonClient4, TupleItem, TupleItemInt, TupleReader, fromNano, Cell, configParse15, configParseValidatorSet, loadConfigParamById, openContract, Contract, ElectorContract, Dictionary, parseTuple, serializeTuple } from "ton";

import fs from 'fs';
import { createBackoff } from "teslabot";
import { Cacheable } from 'cache-flow';
import { Semaphore } from 'async-mutex';
import express, { Express, Request, Response } from 'express';
import { Gauge, register } from "prom-client";
import axios from "axios";

const INTER_BLOCK_DELAY_SECONDS = 3;
const PROMETHEUS_PORT = 8080;

type Config = {
    whalesStakingOwner: string,
    pools: Map<string, {
        maxStake: number,
        contracts: Map<string, string>,
        ADNLs: string[]
    }>
}

const conf: Config = JSON.parse(fs.readFileSync('/etc/ton-status/config.json.new', 'utf-8'));
const pools = conf.pools;

interface Contracts {
    [name: string]: Address;
}
const contracts: Contracts = {};
for (const pool_name of Object.keys(pools)) {
    for (const contractName of Object.keys(pools[pool_name].contracts)) {
        pools[pool_name].contracts[contractName] = Address.parse(pools[pool_name].contracts[contractName]);
        contracts[contractName] = pools[pool_name].contracts[contractName];
    }
}

const v4Client = new TonClient4({ endpoint: "https://mainnet-v4.tonhubapi.com", timeout: 10000 });
const backoff = createBackoff({ onError: (e, i) => i > 3 && console.warn(e), maxFailureCount: 5 });

// // https://stackoverflow.com/questions/54409854/how-to-divide-two-native-javascript-bigints-and-get-a-decimal-result
// class BigDecimal {
//     static decimals: number;
//     bigint: bigint;
//     constructor(value: bigint | number) {
//         let [ints, decis] = String(value).split(".").concat("");
//         decis = decis.padEnd(BigDecimal.decimals, "0");
//         this.bigint = BigInt(ints + decis);
//     }
//     static fromBigInt(bigint: bigint) {
//         return Object.assign(Object.create(BigDecimal.prototype), { bigint });
//     }
//     divide(divisor: BigDecimal): BigDecimal { // You would need to provide methods for other operations
//         return BigDecimal.fromBigInt(this.bigint * BigInt("1" + "0".repeat(BigDecimal.decimals)) / divisor.bigint);
//     }
//     toString() {
//         const s = this.bigint.toString().padStart(BigDecimal.decimals+1, "0");
//         return s.slice(0, -BigDecimal.decimals) + "." + s.slice(-BigDecimal.decimals)
//                 .replace(/\.?0+$/, "");
//     }
// }
// BigDecimal.decimals = 18;

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

// (BigInt.prototype as any).toJSON = function () {
//     return this.toString();
// };

// // TODO: cachable
// async function resolveContractProxy(address: Address) {
//     const ret = (await WrappedClient.runMethodOnLastBlock(address, 'get_proxy'));
//     if (ret.exitCode != 0 && ret.exitCode != 1) {
//         throw Error(`Got unexpextedexit code from get_proxy method call: ${ret.exitCode}`)
//     }
//     return ret.reader.readAddress()
// }

// // TODO: cachable
// async function resolveController(address: Address) {
//     const ret = (await WrappedClient.runMethodOnLastBlock(address, 'get_controller'));
//     if (ret.exitCode != 0 && ret.exitCode != 1) {
//         throw Error(`Got unexpextedexit code from get_controller method call: ${ret.exitCode}`)
//     }
//     return ret.reader.readAddress()
// }

class LastBlock {
    private static instance: LastBlock;
    private static semaphore = new Semaphore(1);
    private constructor() { }

    public static getInstance(): LastBlock {
        if (!LastBlock.instance) {
            LastBlock.instance = new LastBlock();
        }
        return LastBlock.instance;
    }

    public async getSeqno(): Promise<number> {
        return await LastBlock.semaphore.runExclusive(async () => {
            return LastBlock._getSeqno()
        })
    }

    @Cacheable({ options: { expirationTime: INTER_BLOCK_DELAY_SECONDS } })
    private static async _getSeqno(): Promise<number> {
        return (await backoff(() => v4Client.getLastBlock())).last.seqno
    }
}



class WrappedClient extends TonClient4 {
    // public static tupleItemHash(items: TupleItem[]): string {
    //     let hash = "";
    //     if (items == undefined || items.length == 0) {
    //         return ""
    //     }
    //     items.forEach(item => {
    //         switch (item.type) {
    //             case 'tuple': {
    //                 hash += WrappedClient.tupleItemHash(item.items) + "\n";
    //                 break;
    //             }
    //             case 'null': {
    //                 hash += 'null\n';
    //                 break;
    //             }
    //             case 'nan': {
    //                 hash += 'nan\n';
    //                 break;
    //             }
    //             case 'int': {
    //                 hash += (item as TupleItemInt).value.toString() + '\n';
    //                 break;
    //             }
    //             case 'slice':
    //             case 'builder':
    //             case 'cell': {
    //                 const cell = ((item as unknown) as TupleItemCell).cell;
    //                 hash += cell ? cell.hash().toString('hex') + '\n' : 'nullCell\n'
    //                 break;
    //             }
    //             // default: {
    //             //     throw Error(`Unsupported TupleItem type: "${item.type}"`);
    //             // }
    //         }
    //     });
    //     return hash
    // }

    private static serializeTVMExecutionResult(r: TVMExecutionResult): string{
        const obj = {
            exitCode: r.exitCode.toString(),
            result: serializeTuple(r.result).toBoc().toString('base64'),
            // ignore all other
        }
        return JSON.stringify(obj)
    }

    private static parseTVMExecutionResult(s: string): TVMExecutionResult{
        const parsed = JSON.parse(s);
        const resultTuple = parseTuple(Cell.fromBase64(parsed.result));
        const c: TVMExecutionResult = {
            exitCode: parseInt(parsed.exitCode),
            result: resultTuple,
            reader: new TupleReader(resultTuple),
            resultRaw: undefined,
            block: undefined,
            shardBlock: undefined
        }
        return c
    }

    private static objToB64String(o: Object): string {
        return Buffer.from(JSON.stringify(o)).toString('base64');
    }

    @Cacheable({
        options: { expirationTime: INTER_BLOCK_DELAY_SECONDS },
        argsToKey: (address: Address, methodName: string, args?: TupleItem[]) => 
                    WrappedClient.objToB64String([address.toString(), methodName].concat([args ? serializeTuple(args).hash().toString("base64") : "none"])),
        serialize: WrappedClient.serializeTVMExecutionResult,
        deserialize: WrappedClient.parseTVMExecutionResult
    })
    public async runMethodOnLastBlock(address: Address, methodName: string, args?: TupleItem[]): Promise<TVMExecutionResult> {
        const seqno = await LastBlock.getInstance().getSeqno();
        return await this.runMethod(seqno, address, methodName, args);
    }

    @Cacheable({
        options: { maxSize: 10 },
        argsToKey: (seqno: number, address: Address, methodName: string, args?: TupleItem[]) =>
                    WrappedClient.objToB64String([seqno, address.toString(), methodName].concat([args ? serializeTuple(args).hash().toString("base64") : "none"])),
        serialize: WrappedClient.serializeTVMExecutionResult,
        deserialize: WrappedClient.parseTVMExecutionResult
    })
    public async runMethod(seqno: number, address: Address, methodName: string, args?: TupleItem[]): Promise<TVMExecutionResult> {
        return await backoff(() => v4Client.runMethod(seqno, address, methodName, args));
    }

    @Cacheable({options: { expirationTime: INTER_BLOCK_DELAY_SECONDS }})
    public async getLastBlock(): Promise<{
        last: {
            workchain: number;
            shard: string;
            seqno: number;
            fileHash: string;
            rootHash: string;
        };
        init: {
            fileHash: string;
            rootHash: string;
        };
        stateRootHash: string;
        now: number;
    }> {
        return await backoff(() => v4Client.getLastBlock());
    }

    @Cacheable({
        options: { maxSize: 10 },
        argsToKey: (seqno: number, address: Address) => WrappedClient.objToB64String([seqno, address.toString()])
    })
    public async getAccount(block: number, address: Address) {
        return await backoff(() => v4Client.getAccount(block, address));
    }

    @Cacheable({
        options: { maxSize: 10 },
        argsToKey: (seqno: number, address: Address) => WrappedClient.objToB64String([seqno, address.toString()])
    })
    public async getAccountLite(block: number, address: Address) {
        return await backoff(() => v4Client.getAccountLite(block, address));
    }

    @Cacheable({ options: { maxSize: 10 } })
    public async getConfig(seqno: number, ids?: number[]) {
        return await backoff(() => v4Client.getConfig(seqno, ids));
    }

    @Cacheable({
        options: { maxSize: 100 },
        argsToKey: (seqno: number, address: Address) => WrappedClient.objToB64String([seqno, address.toString()])
    })
    public async getBalance(seqno: number, address: Address) {
        return parseFloat((await backoff(() => v4Client.getAccountLite(seqno, address))).account.balance.coins)
    }

    @Cacheable({
        options: { maxSize: 20 },
        serialize: (addr: Address) => {return addr.toString()},
        deserialize: (addr: string) => {return Address.parse(addr)},
    })
    public async resolveContractProxy(address: Address) {
        const ret = (await this.runMethodOnLastBlock(address, 'get_proxy'));
        if (ret.exitCode != 0 && ret.exitCode != 1) {
            throw Error(`Got unexpextedexit code from get_proxy method call: ${ret.exitCode}`)
        }
        return ret.reader.readAddress()
    }

    @Cacheable({
        options: { maxSize: 20 },
        serialize: (addr: Address) => {return addr.toString()},
        deserialize: (addr: string) => {return Address.parse(addr)},
    })
    public async resolveController(address: Address) {
        const ret = (await this.runMethodOnLastBlock(address, 'get_controller'));
        if (ret.exitCode != 0 && ret.exitCode != 1) {
            throw Error(`Got unexpextedexit code from get_controller method call: ${ret.exitCode}`)
        }
        return ret.reader.readAddress()
    }

    // public static async open<T extends Contract>(contract: T) {
    //     const seqno = await LastBlock.getInstance().getSeqno();
    //     return (0, ton_core_1.openContract)(contract, (args) => createProvider(this, block, args.address, args.init));
    //     return v4Client.openAt(seqno, contract)
    // }
}

const wc = new WrappedClient({ endpoint: "https://mainnet-v4.tonhubapi.com", timeout: 10000 });

async function getStakingState() {
    const result = new Map<string, StakingState>();
    const seqno = await LastBlock.getInstance().getSeqno();
    async function _getStakingState(contractName: string, contractAddress: Address) {
        async function _getElectorStakeReqestSeqno() {
            const proxyContractAddress = await wc.resolveContractProxy(contractAddress);
            const accountState = await wc.getAccountLite(seqno, proxyContractAddress);
            const txes = await wc.getAccountTransactions(proxyContractAddress, BigInt(accountState.account.last.lt), Buffer.from(accountState.account.last.hash, 'base64'));
            for (const tx of txes) {
                const opId = tx.tx.inMessage.body.beginParse().loadUint(32);
                if (opId == 0x4e73744b && (tx.tx.inMessage.info.src as Address).equals(contractAddress)) { // int elector::stake::request() asm "0x4e73744b PUSHINT";
                    return tx.block.seqno
                }
            }
            return 0
        }
        const [ret, electorStakeReqestSeqno] = await Promise.all([wc.runMethodOnLastBlock(contractAddress, 'get_staking_status'), _getElectorStakeReqestSeqno()]);
        // https://docs.ton.org/learn/tvm-instructions/tvm-exit-codes
        // 1 is !!!ALTERNATIVE!!! success exit code
        if (ret.exitCode != 0 && ret.exitCode != 1) {
            throw Error(`Got unexpextedexit code from get_staking_status method call: ${ret.exitCode}`)
        }
        const electorStakeReqestAge = INTER_BLOCK_DELAY_SECONDS * (seqno - electorStakeReqestSeqno);
        const stakeAt = ret.reader.readNumber();
        const stakeUntil = ret.reader.readNumber();
        const stakeSent = ret.reader.readBigNumber();
        ret.reader.readNumber(); // skip querySent
        const querySent = electorStakeReqestAge < 5 * 60; // Query sent less than 5 min ago
        const couldUnlock = ret.reader.readNumber() === -1;
        const locked = ret.reader.readNumber() === -1;

        result.set(contractName, { stakeAt, stakeUntil, stakeSent, querySent, couldUnlock, locked })

    }
    const promises = Object.entries(contracts).map(
        ([contractName, contractAddress]) => _getStakingState(contractName, contractAddress)
    );
    await Promise.all(promises);

    return result;
}

// TODO: rewrite this logic to v4 api in connect
// function calculateApy(totalStake: bigint, totalBonuses: bigint, cycleDuration: number): string {
//     const PRECISION = BigInt(1000000);
//     const YEAR_SEC = 365 * 24 * 60 * 60 * 1000;
//     const YEAR_CYCLES = Math.floor(YEAR_SEC / (cycleDuration * 2));

//     //!!!!!!!!!!!!
//     const percentPerCycle = parseInt(((totalBonuses * PRECISION) / totalStake).toString()) / parseInt(PRECISION.toString());
//     //console.log('totalBonuses.muln(PRECISION).div(totalStake)', (totalBonuses * PRECISION) / totalStake);
//     const compound = Math.pow(1 + percentPerCycle, YEAR_CYCLES) - 1;
//     return (compound * 100).toFixed(5);
// }

// function APY(startWorkTime: number, electionEntities: { key: string, amount: bigint, address: string }[], electionsHistory, bonuses: bigint, validatorsElectedFor) {
//     //electionEntities.sort((a, b) => new BN(b.amount).cmp(new BN(a.amount)));
//     electionEntities.sort((a, b) => {
//         if (a.amount > b.amount) {
//             return 1;
//         } else if (a.amount < b.amount) {
//             return -1;
//         } else {
//             return 0;
//         }
//     });

//     //console.log('electionsHistory', electionsHistory);
//     //console.log('startWorkTime', startWorkTime);
//     const filtered = electionsHistory.filter((v) => { return v.id < startWorkTime }).shift()
//     //console.log('filtered', filtered);
//     //console.log('bonuses', bonuses);

//     return calculateApy(BigInt(filtered.totalStake), filtered.id === startWorkTime ? bonuses : BigInt(filtered.bonuses), validatorsElectedFor)
// }

// async function fetchElections() {
//     let latest = ((await axios.get('https://connect.tonhubapi.com/net/mainnet/elections/latest')).data as { elections: number[] }).elections;
//     if (latest.length > 5) {
//         latest = latest.slice(latest.length - 5);
//     }
//     return await Promise.all(latest.map(async (el) => {
//         const r = (await axios.get('https://connect.tonhubapi.com/net/mainnet/elections/' + el)).data as {
//             election: {
//                 unfreezeAt: number,
//                 stakeHeld: number,
//                 bonuses: string,
//                 totalStake: string
//             }
//         };
//         return {
//             id: el,
//             unfreezeAt: r.election.unfreezeAt,
//             stakeHeld: r.election.stakeHeld,
//             bonuses: r.election.bonuses,
//             totalStake: r.election.totalStake
//         };
//     }));
// }

async function resolveOwner(address: Address) {
    const res = (await wc.runMethodOnLastBlock(address, 'get_owner')).result.pop();
    if (res.type === "slice") {
        return res.cell.beginParse().loadAddress();
    }
    throw Error('Got invalid return type from get_owner method of: ' + address.toString());
}


async function getStakingStats() {
    const seqno = await LastBlock.getInstance().getSeqno();
    const elector = wc.open(new ElectorContract());
    const srializedConfigCell = (await wc.getConfig(seqno, [34])).config.cell;
    const currentValidators = configParseValidatorSet(loadConfigParamById(srializedConfigCell, 34).beginParse());
    const startWorkTime = currentValidators.timeSince;
    const elections = await (elector.getPastElections());
    const ex = elections.find((v) => v.id === startWorkTime)!;
    let bonuses = BigInt(0);
    if (ex) {
        bonuses = ex.bonuses;
    }
    //const globalApy = parseFloat(APY(startWorkTime, electionEntities, electionsHistory, bonuses, validatorsElectedFor));
    const globalApy = parseFloat(
        ((await backoff(() => axios.get('https://connect.tonhubapi.com/net/mainnet/elections/latest/apy'))).data as { apy: string }).apy
    )

    const result = new Map<string, {globalApy: number, poolApy: number, poolFee: number, daoShare: number, daoDenominator: number}>();
    async function _getStakingStats(contractName: string, contractAddress: Address) {
        const poolParamsStack = (await wc.runMethodOnLastBlock(contractAddress, 'get_params')).result;
        const poolFee = parseInt(((poolParamsStack[5] as TupleItemInt).value / BigInt(100)).toString());
        const poolApy = (globalApy - globalApy * (poolFee / 100)).toFixed(2);
        const ownerAddress = await resolveOwner(contractAddress);
        let callMethodResult: TVMExecutionResult = undefined;
        let denominator = 1;
        let share = 1;
        callMethodResult = await wc.runMethodOnLastBlock(ownerAddress, 'supported_interfaces');
        if (callMethodResult.exitCode === 0 || callMethodResult.exitCode === 1) {
            const account = await wc.getAccount(seqno, ownerAddress);
            if (account.account.state.type != "active") {
                throw Error(`Got invalid account state: ${account.account.state.type} address: ${ownerAddress.toString()}`);
            }
            const data = Cell.fromBase64(account.account.state.data).beginParse()
            data.loadRef();
            data.loadAddress();
            const nominators = data.loadDict(Dictionary.Keys.BigUint(257), Dictionary.Values.Uint(257));
            const actualDenominator = data.loadInt(257);
            for (const [addrInt, actualShare] of nominators) {
                if (Address.parseRaw("0:" + BigInt(addrInt).toString(16)).equals(Address.parse(conf.whalesStakingOwner))) {
                    denominator = actualDenominator;
                    share = actualShare;
                }
            }
        }
        result.set(contractName, { globalApy, poolApy: parseFloat(poolApy), poolFee, daoShare: share, daoDenominator: denominator });
    }

    const promises = Object.entries(contracts).map(
        ([contractName, contractAddress]) => _getStakingStats(contractName, contractAddress)
    );
    await Promise.all(promises);

    return result
}

async function getComplaintsAddresses() {
    const seqno = await LastBlock.getInstance().getSeqno();
    try {
        const srializedConfigCell = (await wc.getConfig(seqno, [32])).config.cell;
        const prevValidators = configParseValidatorSet(loadConfigParamById(srializedConfigCell, 32).beginParse());
        if (!prevValidators) {
            return { "success": false, msg: "No prevValidators field.", payload: [] }
        }
        const complaintsList: string[] = [];
        const elector = wc.open(new ElectorContract());
        const elections = await backoff(() => elector.getPastElections());
        const complaintsElectionId = prevValidators.timeSince;
        const complaintsElections = elections.find((v) => v.id === complaintsElectionId)!;
        const complaints = await backoff(() => elector.getComplaints(complaintsElectionId));
        const contractAdresses = Object.values(contracts).map((addr) => addr.toString());
        for (const c of complaints) {
            const address = complaintsElections.frozen.get(BigInt(`0x${c.publicKey.toString('hex')}`).toString())!.address.toString();
            if (contractAdresses.includes(address)) {
                complaintsList.push(address);
            }
        }
        return { "success": true, msg: "", payload: complaintsList }

    }
    catch (e) {
        return { "success": false, msg: "Execution failed: " + (e as any).message, payload: [] }
    }
}

type ElectionsStats = {
    timeBeforeElectionEnd: number,
    electionsId: number,
    electorsEndBefore: number
}

async function timeBeforeElectionEnd() {
    const seqno = await LastBlock.getInstance().getSeqno();
    const srializedConfigCell = (await wc.getConfig(seqno, [15])).config.cell;
    const config15 = configParse15(loadConfigParamById(srializedConfigCell, 15).beginParse());
    const currentTimeInSeconds = Math.floor(Date.now() / 1000);
    const elector = wc.open(new ElectorContract());
    const electionsId = await backoff(() => elector.getActiveElectionId());
    var timeBeforeElectionsEnd: number;

    if (electionsId) {
        timeBeforeElectionsEnd = electionsId as number - config15.electorsEndBefore - currentTimeInSeconds;
    }
    else {
        timeBeforeElectionsEnd = 86400;
    }
    const result = new Map<string, ElectionsStats>();
    for (const contractName of Object.keys(contracts)) {
        result.set(contractName, {
            timeBeforeElectionEnd: timeBeforeElectionsEnd,
            electionsId: electionsId ? electionsId : 0,
            electorsEndBefore: config15.electorsEndBefore
        });
    }

    return result
}

type PoolStstus = {
    ctx_balance: number,
    ctx_balance_sent: number,
    ctx_balance_pending_deposits: number,
    steak_for_next_elections: number,
    ctx_balance_pending_withdraw: number,
    ctx_balance_withdraw: number
}

async function getStake() {
    const result = new Map<string, PoolStstus>();
    async function _getStake(contractName: string, contractAddress: Address) {
        const ret = (await wc.runMethodOnLastBlock(contractAddress, 'get_pool_status'));
        if (ret.exitCode === 0 || ret.exitCode === 1) {
            if (ret.result[0].type !== 'int') {
                throw Error('Invalid response');
            }
        } else {
            throw Error(`Got unexpextedexit code from get_pool_status method call: ${ret.exitCode}`)
        }
        const ctx_balance = parseFloat(fromNano(ret.reader.readBigNumber()));
        const ctx_balance_sent = parseFloat(fromNano(ret.reader.readBigNumber()));
        const ctx_balance_pending_deposits = parseFloat(fromNano(ret.reader.readBigNumber()));
        const steak_for_next_elections = ctx_balance + ctx_balance_pending_deposits;
        const ctx_balance_pending_withdraw = parseFloat(fromNano(ret.reader.readBigNumber()));
        const ctx_balance_withdraw = parseFloat(fromNano(ret.reader.readBigNumber()));
        result.set(contractName, {
            ctx_balance,
            ctx_balance_sent,
            ctx_balance_pending_deposits,
            steak_for_next_elections,
            ctx_balance_pending_withdraw,
            ctx_balance_withdraw
        })
    }
    const promises = Object.entries(contracts).map(
        ([contractName, contractAddress]) => _getStake(contractName, contractAddress)
    );
    await Promise.all(promises);

    return result
}

async function electionsQuerySent() {
    const seqno = await LastBlock.getInstance().getSeqno();
    const result = new Map<string, boolean>();
    const elector = wc.open(new ElectorContract());
    // https://github.com/ton-blockchain/ton/blob/24dc184a2ea67f9c47042b4104bbb4d82289fac1/crypto/smartcont/elector-code.fc#L1071
    const electionEntities = await backoff(() => elector.getElectionEntities());
    const stakes = await getStake();
    if (!electionEntities || !electionEntities.entities || electionEntities.entities.length == 0) {
        for (const pool_name of Object.keys(pools)) {
            for (const contractName of Object.keys(pools[pool_name].contracts)) {
                result.set(contractName, false);
            }
        }
        return result;
    }
    const querySentForADNLs = new Map<string, string>();
    for (const entitie of electionEntities.entities) {
        querySentForADNLs.set(entitie.adnl.toString('hex'), entitie.address.toString());
    }

    async function _electionsQuerySent(pool_name: string, contractName: string) {
        const proxyContractAddress = await backoff(() => wc.resolveContractProxy(pools[pool_name].contracts[contractName]));
        const contractStake = stakes.get(contractName);
        const maxStake = pools[pool_name].maxStake;
        const validatorsNeeded = Math.ceil(contractStake.ctx_balance /maxStake);
        let quesrySentForNCurrentElectors = 0;
        for (const ADNL of pools[pool_name].ADNLs) {
            if (Array.from(querySentForADNLs.keys()).includes(ADNL.toLowerCase())) {
                if (querySentForADNLs.get(ADNL.toLowerCase()) == proxyContractAddress.toString()) {
                    quesrySentForNCurrentElectors++;
                }
            }
        }
        result.set(contractName, validatorsNeeded <= quesrySentForNCurrentElectors);
    }

    const promises = [];
    for (const pool_name of Object.keys(pools)) {
        for (const contractName of Object.keys(pools[pool_name].contracts)) {
            promises.push(_electionsQuerySent(pool_name, contractName))
        }
    }
    await Promise.all(promises)

    return result
}

async function mustParticipateInCycle() {
    const seqno = await LastBlock.getInstance().getSeqno();
    const srializedConfigCell = (await wc.getConfig(seqno, [34])).config.cell;
    const currentValidators = configParseValidatorSet(loadConfigParamById(srializedConfigCell, 34).beginParse());
    const elector = wc.open(new ElectorContract());
    const elections = await backoff(() => elector.getPastElections());
    const ex = elections.find(v => v.id === currentValidators!.timeSince)!;
    const validatorProxyAddresses = [];
    for (const key of currentValidators!.list!.keys()) {
        const val:{publicKey: Buffer} = currentValidators!.list!.get(key)!;
        const v = ex.frozen.get(BigInt(`0x${val.publicKey.toString('hex')}`).toString());
        validatorProxyAddresses.push(v.address.toString());
    }

    const result = new Map<string, boolean>();
    async function _mustParticipateInCycle(contractName: string, contractAddress: Address) {
        const proxyContractAddress = await wc.resolveContractProxy(contractAddress);
        result.set(contractName, !validatorProxyAddresses.includes(proxyContractAddress.toString()))
    }
    const promises = Object.entries(contracts).map(
            ([contractName, contractAddress]) => _mustParticipateInCycle(contractName, contractAddress)
    );
    await Promise.all(promises);

    return result
}

async function poolsSize(): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    for (const pool_name of Object.keys(pools)) {
        for (const contractName of Object.keys(pools[pool_name].contracts)) {
           result.set(contractName, pools[pool_name].ADNLs.length);
        }
    }
    return result
}

async function unowned(){
    const result = new Map<string, number>();
    async function _getUnowned (contractName: string, contractAddress: Address) {
        const ret = (await wc.runMethodOnLastBlock(contractAddress, 'get_unowned'));
        // https://docs.ton.org/learn/tvm-instructions/tvm-exit-codes
        // 1 is !!!ALTERNATIVE!!! success exit code
        if (ret.exitCode != 0 && ret.exitCode != 1) {
            throw Error(`Got unexpextedexit code from get_unowned method call: ${ret.exitCode}`)
        }
        result.set(contractName, parseFloat(fromNano(ret.reader.readBigNumber())))
    }
    const promises = Object.entries(contracts).map(
            ([contractName, contractAddress]) => _getUnowned(contractName, contractAddress)
    );
    await Promise.all(promises);

    return result
}

async function controllersBalance(): Promise<Map<string, number>> {
    const seqno = await LastBlock.getInstance().getSeqno();
    const result = new Map<string, number>();
    async function _controllersBalance (contractName: string, contractAddress: Address) {
        const controllerAddress = await wc.resolveController(contractAddress);
        const balance = await wc.getBalance(seqno, controllerAddress);
        result.set(contractName, parseFloat(fromNano(balance)));
    }
    const promises = Object.entries(contracts).map(
            ([contractName, contractAddress]) => _controllersBalance(contractName, contractAddress)
    );
    await Promise.all(promises);

    return result
}

async function getValidatorsStats(): Promise<{quantity: number, totalStake: number}> {
    const seqno = await LastBlock.getInstance().getSeqno();
    const srializedConfigCell = (await wc.getConfig(seqno, [34])).config.cell;
    const currentValidators = configParseValidatorSet(loadConfigParamById(srializedConfigCell, 34).beginParse());
    const elector = wc.open(new ElectorContract());
    let elections = await backoff(() => elector.getPastElections());
    let ex = elections.find(v => v.id === currentValidators!.timeSince)!;
    let all = BigInt(0);
    [...currentValidators.list.values()].map(
        (entity) => {
            all += ex.frozen.get(BigInt(`0x${entity.publicKey.toString('hex')}`).toString()).stake
        }
        
    );
    return {quantity: currentValidators.total, totalStake: parseFloat(fromNano(all))}
}

async function getNextElectionsTime(): Promise<number> {
    const seqno = await LastBlock.getInstance().getSeqno();
    const srializedConfigCell = (await wc.getConfig(seqno, [15, 34, 36])).config.cell;
    const config15 = configParse15(loadConfigParamById(srializedConfigCell, 15).beginParse());
    const currentValidators = configParseValidatorSet(loadConfigParamById(srializedConfigCell, 34).beginParse());
    const config36Raw = loadConfigParamById(srializedConfigCell, 36)
    const nextValidators = config36Raw ? configParseValidatorSet(config36Raw.beginParse()) : {timeSince: null};
    const startWorkTimeNext = nextValidators?.timeSince || false;
    const startWorkTimeCurrent = currentValidators!.timeSince;
    const elector = wc.open(new ElectorContract());
    const startWorkTimeFromElections = await backoff(() => elector.getActiveElectionId());
    const oldStartWorkTime = startWorkTimeNext ? startWorkTimeNext : startWorkTimeCurrent
    const startWorkTime = startWorkTimeFromElections ? startWorkTimeFromElections : oldStartWorkTime
    const electorsStartBefore = config15.electorsStartBefore;
    const validatorsElectedFor = config15.validatorsElectedFor;
    const startElection = startWorkTime - electorsStartBefore;
    const startNextElection = startElection + validatorsElectedFor;
    return startNextElection
}

//  -------------------------------

function valueToInt(value: bigint | boolean): number {
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

const funcToMetricNames = new Map<Function, string[]>();
function memoizeMetric(func: Function, metric: string) {
    if (funcToMetricNames.get(func).indexOf(metric) === -1) {
        funcToMetricNames.get(func).push(metric);
    }
}

function consumeMetric(func: () => Promise<Map<string, any> | void>, metricName: string, poolLabel: {pool: string} | {}, value: any) {
    const sanitizedMetricName = toCamel(metricName);
    memoizeMetric(func, sanitizedMetricName);
    const labelNames = Object.keys(poolLabel);
    if (sanitizedMetricName in register["_metrics"]) {
        const gauge = register["_metrics"][sanitizedMetricName];
        const mutableGauge = labelNames ? gauge.labels(poolLabel) : gauge;
        mutableGauge.set(valueToInt(value));
    } else {
        const gauge = new Gauge({ name: sanitizedMetricName, help: 'h', labelNames: labelNames });
        const mutableGauge = labelNames ? gauge.labels(poolLabel) : gauge
        mutableGauge.set(valueToInt(value));
    }

}

function deleteMetrics(func: () => Promise<Map<string, any>>) {
    for (const metricName of funcToMetricNames.get(func)) {
        if (metricName in register["_metrics"]) {
            console.log("Delteting ", metricName, " metric.");
            delete register["_metrics"][metricName];
        }
    }
}

async function exposeMetrics(func: () => Promise<Map<string, any>>) {
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
    if (!funcToMetricNames.has(func)) {
        funcToMetricNames.set(func, []);
    }
    for (const [poolName, obj] of result.entries()) {
        const poolLabel = { pool: poolName.toLowerCase().replace(/#/g, '').replace(/ /g, '_') };
        if (['number', 'boolean'].includes(typeof obj)) {
            consumeMetric(func, func.name, poolLabel, obj);
            continue
        }
        for (const [metricName, value] of Object.entries(obj)) {
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

const collectFunctions = [getStakingState, timeBeforeElectionEnd, electionsQuerySent, getStake, mustParticipateInCycle, poolsSize, unowned, controllersBalance, getStakingStats];
const seconds = 30;
const interval = seconds * 1000;

async function startExporter() {
    const app: Express = express();
    for (const func of collectFunctions) {
        exposeMetrics(func);
        setInterval(async function () { await exposeMetrics(func) }, interval);
    }
    funcToMetricNames.set(exposeComplaints, []);
    exposeComplaints();
    setInterval(async function () {await exposeComplaints()}, interval);
    funcToMetricNames.set(exposeValidatorsStats, []);
    exposeValidatorsStats();
    setInterval(async function () {await exposeValidatorsStats()}, interval);
    funcToMetricNames.set(exposeNextElectionsTime, []);
    exposeNextElectionsTime();
    setInterval(async function () {await exposeNextElectionsTime()}, interval);
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
    await startExporter();
}

main()