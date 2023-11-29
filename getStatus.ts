import { Address, TonClient4, TupleItem, TupleItemInt, TupleReader, fromNano, Cell, configParse15, configParseValidatorSet, loadConfigParamById, ElectorContract, Dictionary, parseTuple, serializeTuple, TonClient4Parameters, toNano } from "@ton/ton";

import fs from 'fs';
import { createBackoff } from "teslabot";
import { Cacheable, CacheableParams } from 'cache-flow';
import { Semaphore } from 'async-mutex';
import express, { Express, Request, Response } from 'express';
import { Gauge, register } from "prom-client";
import { encode, decode, ExtensionCodec, DecodeError } from "@msgpack/msgpack";
import axios from "axios";
import * as crypto from "crypto";

const INTER_BLOCK_DELAY_SECONDS = 3;
const PROMETHEUS_PORT = 8080;

type Config = {
    whalesStakingOwner: string,
    pools: {[name: string]: {
        maxStake: number,
        contracts: Map<string, string>,
        ADNLs: string[]
    }}
    liquidPools: {[name: string]: {
        network: string,
        minStake: number,
        maxStake: number,
        contract: string,
        ADNLs: string[]
    }},
}

const CONFIG_FILENAME = 'config.json.new';
const SYSTEM_CONFIG_PATH = '/etc/ton-status/';

const configPath = fs.existsSync(SYSTEM_CONFIG_PATH + CONFIG_FILENAME) ? SYSTEM_CONFIG_PATH + CONFIG_FILENAME : `./${CONFIG_FILENAME}`
const conf: Config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
const pools = conf.pools;
const liquidPools = conf.liquidPools;


interface Contracts {
    [name: string]: Address;
}
const genericContracts: Contracts = {};
for (const pool_name of Object.keys(pools)) {
    for (const contractName of Object.keys(pools[pool_name].contracts)) {
        pools[pool_name].contracts[contractName] = Address.parse(pools[pool_name].contracts[contractName]);
        genericContracts[contractName] = pools[pool_name].contracts[contractName];
    }
}
const liquidContracts: Contracts = {};
for (const pool_name of Object.keys(liquidPools)) {
    liquidContracts[pool_name] = Address.parse(liquidPools[pool_name].contract)
}

const v4Client = new TonClient4({ endpoint: "https://mainnet-v4.tonhubapi.com", timeout: 10000 });
const v4ClientTestnet = new TonClient4({ endpoint: "https://sandbox-v4.tonhubapi.com", timeout: 10000 });
const backoff = createBackoff({ onError: (e, i) => i > 3 && console.warn(e), maxFailureCount: 5 });

function getClient(testnet=false) {
    if (testnet) {
        return v4ClientTestnet
    }
    return v4Client
}

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
    locked?: boolean;
    finalized?: boolean;
};


// type TVMExecutionResult = {
//     exitCode: number;
//     result: TupleItem[];
//     resultRaw: string | null;
//     block: {
//         workchain: number;
//         shard: string;
//         seqno: number;
//         fileHash: string;
//         rootHash: string;
//     };
//     shardBlock: {
//         workchain: number;
//         shard: string;
//         seqno: number;
//         fileHash: string;
//         rootHash: string;
//     };
//     reader: TupleReader;
// }

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

// class LastBlock {
//     private static instance: LastBlock;
//     private static semaphore = new Semaphore(1);
//     private constructor() { }

//     public static getInstance(): LastBlock {
//         if (!LastBlock.instance) {
//             LastBlock.instance = new LastBlock();
//         }
//         return LastBlock.instance;
//     }

//     public async getSeqno(testnet=false): Promise<number> {
//         return await LastBlock.semaphore.runExclusive(async () => {
//             return LastBlock._getSeqno(testnet)
//         })
//     }

//     @Cacheable({ options: { expirationTime: INTER_BLOCK_DELAY_SECONDS } })
//     private static async _getSeqno(testnet: boolean): Promise<number> {
//         return (await backoff(() => getClient(testnet).getLastBlock())).last.seqno
//     }
// }


const BIGINT_EXT_TYPE = 0; // Any in 0-127
const ADDRESS_EXT_TYPE = 1;
const TUPLE_READER_EXT_TYPE = 2;
const CELL_EXT_TYPE = 3;
const extensionCodec = new ExtensionCodec();
extensionCodec.register({
  type: BIGINT_EXT_TYPE,
  encode(input: unknown): Uint8Array | null {
    if (typeof input === "bigint") {
      if (input <= BigInt(Number.MAX_SAFE_INTEGER) && input >= BigInt(Number.MIN_SAFE_INTEGER)) {
        return encode(Number(input));
      } else {
        return encode(String(input));
      }
    } else if (input instanceof BigInt) {
        return encode(String(input));
    } else {
      return null;
    }
  },
  decode(data: Uint8Array): bigint {
    const val = decode(data);
    if (!(typeof val === "string" || typeof val === "number")) {
      throw new DecodeError(`unexpected BigInt source: ${val} (${typeof val})`);
    }
    return BigInt(val);
  },
});
extensionCodec.register({
    type: ADDRESS_EXT_TYPE,
    encode(input: unknown): Uint8Array | null {
        if (input instanceof Address) {
            return encode(input.toString())
        } else {
            return null;
        }
    },
    decode(data: Uint8Array): Address {
        const val = decode(data);
        if (!(typeof val === "string")) {
            throw new DecodeError(`unexpected Address source: ${val} (${typeof val})`);
        }
        return Address.parse(val);
    },
});

extensionCodec.register({
    type: CELL_EXT_TYPE,
    encode(input: unknown): Uint8Array | null {
        if (input instanceof Cell) {
            return encode(input.toBoc({idx: false}))
        } else {
            return null;
        }
    },
    decode(data: Uint8Array): Cell {
        const val = decode(data);
        return Cell.fromBoc((val as Buffer))[0];
    },
});

extensionCodec.register({
    type: TUPLE_READER_EXT_TYPE,
    encode(input: unknown): Uint8Array | null {
        if (input instanceof TupleReader) {
            const tuple: TupleItem[] = [];
            while (input.remaining) {
                tuple.push(input.pop())
            }
            const seralized = serializeTuple(tuple).toBoc().toString('base64');
            // this is a DIRTY hackaround to restore mutated state. deep copy is not working
            (input as any).items = (new TupleReader(parseTuple(Cell.fromBase64(seralized))) as any).items;
            return encode(serializeTuple(tuple).toBoc().toString('base64'))
        } else {
            return null;
        }
    },
    decode(data: Uint8Array): TupleReader {
        const val = decode(data);
        const tuple = parseTuple(Cell.fromBase64(val as string));
        return new TupleReader(tuple)
    },
});

function serialize(r: any) {
        return encode(r, { extensionCodec })
}

function deserialize(e: any) {
    const d = decode(e, { extensionCodec })
    return d
}

const mutexes = new Map<string, Semaphore>();

function Sequential(target: Object, propertyKey: string, descriptor: TypedPropertyDescriptor<any>) {
    const originalMethod = descriptor.value; // save a reference to the original method

    // NOTE: Do not use arrow syntax here. Use a function expression in 
    // order to use the correct value of `this` in this method (see notes below)
    descriptor.value = async function(...args: any[]) {
        const funcName = new Uint8Array(Buffer.from(propertyKey));
        const buf = serialize(args);
        const concat = new Uint8Array([...funcName, ...buf]);
        const hash = crypto.createHash('md5').update(concat).digest("base64");
        if (!mutexes.get(hash)) {
            mutexes.set(hash, new Semaphore(1));
        }
        const mutex = mutexes.get(hash);

        return await mutex.runExclusive(async () => {
            const result = await originalMethod.apply(this, args);
            return result
        });
    };
    return descriptor;
}


class WrappedClient extends TonClient4 {
    private readonly isTestnet: boolean;

    constructor(args: TonClient4Parameters, testnet = false) {
        super(args)
        this.isTestnet = testnet
    }

    // private static parseTVMExecutionResult(s: string): Awaited<ReturnType<typeof TonClient4.prototype.runMethod>>{
    //     const parsed = JSON.parse(s);
    //     const resultTuple = parseTuple(Cell.fromBase64(parsed.result));
    //     const c: Awaited<ReturnType<typeof TonClient4.prototype.runMethod>> = {
    //         exitCode: parseInt(parsed.exitCode),
    //         result: resultTuple,
    //         reader: new TupleReader(resultTuple),
    //         resultRaw: undefined,
    //         block: undefined,
    //         shardBlock: undefined
    //     }
    //     return c
    // }

    private static objToB64String(o: Object): string {
        return Buffer.from(JSON.stringify(o)).toString('base64');
    }

    @Cacheable({
        options: { expirationTime: INTER_BLOCK_DELAY_SECONDS },
        argsToKey: (address: Address, methodName: string, args?: TupleItem[]) =>
                    WrappedClient.objToB64String([address.toString(), methodName].concat([args ? serializeTuple(args).hash().toString("base64") : "none"])),
        // serialize: WrappedClient.serializeTVMExecutionResult,
        // deserialize: WrappedClient.parseTVMExecutionResult
        serialize: serialize,
        deserialize: deserialize
    })
    public async runMethodOnLastBlock(address: Address, methodName: string, args?: TupleItem[]): ReturnType<typeof TonClient4.prototype.runMethod> {
        const seqno = await this.getLastSeqno(this.isTestnet);
        return await this.runMethod(seqno, address, methodName, args);
    }

    @Sequential
    @Cacheable({
        options: { maxSize: 10 },
        argsToKey: (seqno: number, address: Address, methodName: string, args?: TupleItem[]) =>
                    WrappedClient.objToB64String([seqno, address.toString(), methodName].concat([args ? serializeTuple(args).hash().toString("base64") : "none"])),
        serialize: serialize,
        deserialize: deserialize
        // serialize: WrappedClient.serializeTVMExecutionResult,
        // deserialize: WrappedClient.parseTVMExecutionResult
    })
    public async runMethod(seqno: number, address: Address, methodName: string, args?: TupleItem[]): ReturnType<typeof TonClient4.prototype.runMethod> {
        return await backoff(() => super.runMethod(seqno, address, methodName, args));
    }

    // @Cacheable({options: { expirationTime: INTER_BLOCK_DELAY_SECONDS }})
    // public async getLastBlock(): ReturnType<typeof TonClient4.prototype.getLastBlock> {
    //     return await backoff(() => super.getLastBlock());
    // }

    @Sequential
    @Cacheable({options: { expirationTime: INTER_BLOCK_DELAY_SECONDS }})
    // unused arg is MANDDATORY for cache to work properly
    public async getLastSeqno(testnet = false) {
        return (await super.getLastBlock()).last.seqno;
    }

    @Sequential
    @Cacheable({
        options: { maxSize: 10 },
        argsToKey: (seqno: number, address: Address) => WrappedClient.objToB64String([seqno, address.toString()])
    })
    public async getAccount(block: number, address: Address) {
        return await backoff(() => super.getAccount(block, address));
    }

    @Sequential
    @Cacheable({
        options: { maxSize: 10 },
        argsToKey: (seqno: number, address: Address) => WrappedClient.objToB64String([seqno, address.toString()])
    })
    public async getAccountLite(block: number, address: Address) {
        return await backoff(() => super.getAccountLite(block, address));
    }

    @Sequential
    @Cacheable({ options: { maxSize: 10 } })
    public async getConfig(seqno: number, ids?: number[]) {
        return await backoff(() => super.getConfig(seqno, ids));
    }

    @Sequential
    @Cacheable({
        options: { maxSize: 100 },
        argsToKey: (seqno: number, address: Address) => WrappedClient.objToB64String([seqno, address.toString()])
    })
    public async getBalance(seqno: number, address: Address) {
        return parseFloat((await backoff(() => super.getAccountLite(seqno, address))).account.balance.coins)
    }

    @Cacheable({
        options: { maxSize: 20 },
        argsToKey: (address: Address, queue: number|null) => WrappedClient.objToB64String([address.toString(), queue]),
        serialize: serialize,
        deserialize: deserialize
        // serialize: (addr: Address) => {return addr.toString()},
        // deserialize: (addr: string) => {return Address.parse(addr)},
    })
    public async resolveContractProxy(address: Address, queue=null) {
        const method = queue == null ? 'get_proxy' : 'get_proxies';
        const ret = (await this.runMethodOnLastBlock(address, method));
        if (ret.exitCode != 0 && ret.exitCode != 1) {
            throw Error(`Got unexpextedexit code from ${method} method call: ${ret.exitCode}`)
        }
        if (queue != 1) { // in this case we have queue==null or queue==0. in both cases we must return first readen address
            return ret.reader.readAddress()
        }
        ret.reader.skip()
        return ret.reader.readAddress()
    }

    @Cacheable({
        options: { maxSize: 20 },
        serialize: serialize,
        deserialize: deserialize
        // serialize: (addr: Address) => {return addr.toString()},
        // deserialize: (addr: string) => {return Address.parse(addr)},
    })
    public async resolveController(address: Address) {
        const ret = (await this.runMethodOnLastBlock(address, 'get_controller'));
        if (ret.exitCode != 0 && ret.exitCode != 1) {
            throw Error(`Got unexpextedexit code from get_controller method call: ${ret.exitCode}`)
        }
        return ret.reader.readAddress()
    }

    @Cacheable({
        options: { maxSize: 20 },
        serialize: serialize,
        deserialize: deserialize
        // serialize: (addr: Address) => {return addr.toString()},
        // deserialize: (addr: string) => {return Address.parse(addr)},
    })
    public async resolveOwner(address: Address) {
        const res = (await this.runMethodOnLastBlock(address, 'get_owner')).result.pop();
        if (res.type === "slice") {
            return res.cell.beginParse().loadAddress();
        }
        throw Error('Got invalid return type from get_owner method of: ' + address.toString());
    }

    @Cacheable({ options: { expirationTime: 5 * 60 } })
    static async getGlobalApy(testnet=false) {
        const network = testnet ? 'testnet' : 'mainnet'
        const globalApy = parseFloat(
            ((await backoff(() => axios.get(`https://connect.tonhubapi.com/net/${network}/elections/latest/apy`))).data as { apy: string }).apy
        )
        return globalApy
    }

    // public static async open<T extends Contract>(contract: T) {
    //     const seqno = await LastBlock.getInstance().getSeqno();
    //     return (0, ton_core_1.openContract)(contract, (args) => createProvider(this, block, args.address, args.init));
    //     return v4Client.openAt(seqno, contract)
    // }
}

const wc = new WrappedClient({ endpoint: "https://mainnet-v4.tonhubapi.com", timeout: 10000 }, false);
const wcTetstnet = new WrappedClient({ endpoint: "https://sandbox-v4.tonhubapi.com", timeout: 10000 }, true);

function getWC(testnet=false) {
    if (testnet) {
        return wcTetstnet
    }
    return wc
}

function getStakeToAllocateLiquid(available: bigint, minStake: bigint) {
    const EPS = toNano(1);
    return (minStake + EPS) * BigInt(2) <= available ? available / BigInt(2) : available
}

async function getStakingState() {
    const result = new Map<string, StakingState>();
    async function _getStakingState(contractName: string, contractAddress: Address, queue=null, testnet=false) {
        const seqno = await getWC(testnet).getLastSeqno(testnet);
        async function _getElectorStakeReqestSeqno() {
            const proxyContractAddress = await getWC(testnet).resolveContractProxy(contractAddress, queue);
            const accountState = await getWC(testnet).getAccountLite(seqno, proxyContractAddress);
            const txes = await getWC(testnet).getAccountTransactions(proxyContractAddress, BigInt(accountState.account.last.lt), Buffer.from(accountState.account.last.hash, 'base64'));
            for (const tx of txes) {
                try {
                    const opId = tx.tx.inMessage.body.beginParse().loadUint(32);
                    if (opId == 0x4e73744b && (tx.tx.inMessage.info.src as Address).equals(contractAddress)) { // int elector::stake::request() asm "0x4e73744b PUSHINT";
                        return tx.block.seqno
                    }
                } catch (e) {
                    console.log(`Error trying to parse proxy transaction: \n${e}`)
                }
            }
            return 0
        }
        const [ret, electorStakeReqestSeqno] = await Promise.all(
            [getWC(testnet).runMethodOnLastBlock(
                contractAddress, 
                'get_staking_status',
                queue == null ? [] : [{ type: 'int', value: BigInt(queue)}]),
            _getElectorStakeReqestSeqno()
            ]
        );
        // https://docs.ton.org/learn/tvm-instructions/tvm-exit-codes
        // 1 is !!!ALTERNATIVE!!! success exit code
        if (ret.exitCode != 0 && ret.exitCode != 1) {
            const details = `\nAddress: ${contractAddress.toString()}\nArgs: ${JSON.stringify(queue == null ? [] : [{ type: 'int', value: queue}])}`
            throw Error(`Got unexpextedexit code from get_staking_status method call. Exit code: ${ret.exitCode}${details}`)
        }
        const electorStakeReqestAge = INTER_BLOCK_DELAY_SECONDS * (seqno - electorStakeReqestSeqno);
        const stakeAt = ret.reader.readNumber();
        const stakeUntil = ret.reader.readNumber();
        const stakeSent = ret.reader.readBigNumber();
        ret.reader.readNumber(); // skip querySent
        const querySent = electorStakeReqestAge < 5 * 60; // Query sent less than 5 min ago
        const couldUnlock = ret.reader.readNumber() === -1;
        const lockedOrFinalized = ret.reader.readNumber() === -1;
        const metricName = queue == null ? contractName : `${contractName}_${queue + 1}`
        const state: StakingState = {stakeAt, stakeUntil, stakeSent, querySent, couldUnlock}
        if (queue == null) {
            state.locked = lockedOrFinalized;
        } else {
            state.finalized = lockedOrFinalized;
        }
        result.set(metricName, state)

    }
    const genericPromises = Object.entries(genericContracts).map(
        ([contractName, contractAddress]) => _getStakingState(contractName, contractAddress)
    );
    const lqTriplets = Object.entries(liquidContracts).reduce((accumulator, currentValue) => accumulator.concat([[ ...currentValue, 0], [...currentValue, 1]]), [])
    
    const lqPromises = lqTriplets.map(
        ([contractName, contractAddress, queue]) => _getStakingState(contractName, contractAddress, queue, liquidPools[contractName].network == "testnet")
    );
    await Promise.all(genericPromises.concat(lqPromises));

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


async function getStakingStats() {
    //const elector = getWC().open(new ElectorContract());
    //const srializedConfigCell = (await getWC().getConfig(seqno, [34])).config.cell;
    //const currentValidators = configParseValidatorSet(loadConfigParamById(srializedConfigCell, 34).beginParse());
    // const startWorkTime = currentValidators.timeSince;
    // const elections = await (elector.getPastElections());
    //const ex = elections.find((v) => v.id === startWorkTime)!;
    // let bonuses = BigInt(0);
    // if (ex) {
    //     bonuses = ex.bonuses;
    // }
    //const globalApy = parseFloat(APY(startWorkTime, electionEntities, electionsHistory, bonuses, validatorsElectedFor));


    const result = new Map<string, {globalApy: number, poolApy: number, poolFee: number, daoShare: number, daoDenominator: number}>();
    async function _getStakingStats(contractName: string, contractAddress: Address, liquid=false, testnet=false) {
        const seqno = await getWC(testnet).getLastSeqno(testnet);
        const method = liquid ? 'get_pool_status' : 'get_params'
        const poolParamsStack = (await getWC(testnet).runMethodOnLastBlock(contractAddress, method)).result;
        const poolFeeParamIndex = liquid ? 9 : 5
        const poolFee = parseInt(((poolParamsStack[poolFeeParamIndex] as TupleItemInt).value / BigInt(100)).toString());
        const poolApy = (await WrappedClient.getGlobalApy(testnet) - await WrappedClient.getGlobalApy(testnet) * (poolFee / 100)).toFixed(2);
        let denominator = 1;
        let share = 1;
        const ownerAddress = await getWC(testnet).resolveOwner(contractAddress);
        let callMethodResult: Awaited<ReturnType<typeof TonClient4.prototype.runMethod>> = undefined;
        callMethodResult = await getWC(testnet).runMethodOnLastBlock(ownerAddress, 'supported_interfaces');
        if (callMethodResult.exitCode === 0 || callMethodResult.exitCode === 1) {
            const account = await getWC(testnet).getAccount(seqno, ownerAddress);
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
        const value = { globalApy: await WrappedClient.getGlobalApy(testnet), poolApy: parseFloat(poolApy), poolFee, daoShare: share, daoDenominator: denominator }
        if (!liquid) {
            result.set(contractName, value);
        } else {
            for (let queue = 1; queue <= 2; queue++) {
                result.set(`${contractName}_${queue}`, value);
            }
        }
        
    }

    const genericPromises = Object.entries(genericContracts).map(
        ([contractName, contractAddress]) => _getStakingStats(contractName, contractAddress)
    );
    const lqPromises = Object.entries(liquidContracts).map(
        ([contractName, contractAddress]) => _getStakingStats(contractName, contractAddress, true, liquidPools[contractName].network == "testnet")
    );
    await Promise.all(genericPromises.concat(lqPromises));

    return result
}

async function getComplaintsAddresses() {
    const seqno = await getWC(false).getLastSeqno(false);
    try {
        const srializedConfigCell = (await getWC().getConfig(seqno, [32])).config.cell;
        const prevValidators = configParseValidatorSet(loadConfigParamById(srializedConfigCell, 32).beginParse());
        if (!prevValidators) {
            return { "success": false, msg: "No prevValidators field.", payload: [] }
        }
        const complaintsList: string[] = [];
        const elector = getWC().open(new ElectorContract());
        //const elections = await getWC().getPastElections();
        const elections = await elector.getPastElections();
        const complaintsElectionId = prevValidators.timeSince;
        const complaintsElections = elections.find((v) => v.id === complaintsElectionId)!;
        const complaints = await backoff(() => elector.getComplaints(complaintsElectionId));
        const contractAdresses = Object.values(genericContracts).map((addr) => addr.toString());
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
    const result = new Map<string, ElectionsStats>();

    class ElectionWatcher {
        @Cacheable({ options: { expirationTime: INTER_BLOCK_DELAY_SECONDS } })
        static async timeBeforeElectionEnd(testnet: boolean) {
            const seqno = await getWC(testnet).getLastSeqno(testnet);
            const srializedConfigCell = (await getWC(testnet).getConfig(seqno, [15])).config.cell;
            const config15 = configParse15(loadConfigParamById(srializedConfigCell, 15).beginParse());
            const elector = getWC(testnet).openAt(seqno, new ElectorContract());
            const electionsId = await backoff(() => elector.getActiveElectionId());
            return {config15, electionsId}
        }
    }

    async function _timeBeforeElectionEnd(contractName: string, testnet=false) {
        const {config15, electionsId} = await ElectionWatcher.timeBeforeElectionEnd(testnet)
        var timeBeforeElectionsEnd: number;
        const currentTimeInSeconds = Math.floor(Date.now() / 1000);

        if (electionsId) {
            timeBeforeElectionsEnd = electionsId as number - config15.electorsEndBefore - currentTimeInSeconds;
        }
        else {
            timeBeforeElectionsEnd = 86400;
        }
        const value = { timeBeforeElectionEnd: timeBeforeElectionsEnd, electionsId: electionsId ? electionsId : 0, electorsEndBefore: config15.electorsEndBefore }
        result.set(contractName, value);
    }

    const promises = [];
    for (const contractName of Object.keys(genericContracts)) {
        //result.set(contractName, await ElectionWatcher.timeBeforeElectionEnd());
        promises.push(_timeBeforeElectionEnd(contractName))
    }
    for (const contractName of Object.keys(liquidContracts)) {
        for (let queue = 1; queue <= 2; queue++) {
            promises.push(_timeBeforeElectionEnd(`${contractName}_${queue}`, liquidPools[contractName].network == "testnet"))
        }
    }

    await Promise.all(promises);

    return result
}

type PoolStatus = {
    ctx_balance: number,
    ctx_balance_sent: number,
    ctx_balance_pending_withdraw: number,
    ctx_balance_withdraw: number,
    steak_for_next_elections: number
}
type PoolStatusGeneric = PoolStatus & {
    type?: "generic",
    ctx_balance_pending_deposits: number,
}

type PoolStatusLiquid = PoolStatus & {
    type?: "liquid",
    deposit_rate: number,
    withdraw_rate: number,
    ctx_round_id: number,
    ctx_minter_total_supply: number,
}

async function getStake() {
    const result = new Map<string, PoolStatusGeneric|PoolStatusLiquid>();
    async function _getStakeGeneric(contractName: string, contractAddress: Address) {
        const ret = (await getWC().runMethodOnLastBlock(contractAddress, 'get_pool_status'));
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
        const stat: PoolStatusGeneric = {
            ctx_balance,
            ctx_balance_sent,
            ctx_balance_pending_deposits,
            steak_for_next_elections,
            ctx_balance_pending_withdraw,
            ctx_balance_withdraw
        }
        delete stat.type;
        result.set(contractName, stat);
    }
    async function _getStakeLiquid(contractName: string, contractAddress: Address, testnet: boolean, minStake: number) {
        const ret = (await getWC(testnet).runMethodOnLastBlock(contractAddress, 'get_pool_status'));
        if (ret.exitCode === 0 || ret.exitCode === 1) {
            if (ret.result[0].type !== 'int') {
                throw Error('Invalid response');
            }
        } else {
            throw Error(`Got unexpextedexit code from get_pool_status method call: ${ret.exitCode}`)
        }

        const deposit_rate = parseFloat(fromNano(ret.reader.readBigNumber()));
        const withdraw_rate = parseFloat(fromNano(ret.reader.readBigNumber()));
        const ctx_round_id = parseFloat(fromNano(ret.reader.readBigNumber()));
        ret.reader.skip(); // enabled
        ret.reader.skip(); // udpates_enabled
        ret.reader.skip(); // min_stake
        ret.reader.skip(); // deposit_fee
        ret.reader.skip(); // withdraw_fee
        ret.reader.skip(); // receipt_price
        ret.reader.skip(); // pool_fee
        const ctx_minter_total_supply = parseFloat(fromNano(ret.reader.readBigNumber()));
        const ctx_balance = parseFloat(fromNano(ret.reader.readBigNumber()));
        const ctx_balance_sent = parseFloat(fromNano(ret.reader.readBigNumber()));
        const ctx_balance_pending_withdraw = parseFloat(fromNano(ret.reader.readBigNumber()));
        const ctx_balance_withdraw = parseFloat(fromNano(ret.reader.readBigNumber()));

        const stat: PoolStatusLiquid = {
            deposit_rate,
            withdraw_rate,
            ctx_round_id,
            ctx_minter_total_supply,
            ctx_balance,
            ctx_balance_sent,
            ctx_balance_pending_withdraw,
            ctx_balance_withdraw,
            steak_for_next_elections: parseFloat(fromNano(getStakeToAllocateLiquid(toNano((ctx_balance - ctx_balance_pending_withdraw).toFixed(2)), toNano(minStake))))
        }
        delete stat.type;

        for (let queue = 1; queue <= 2; queue++) {
            result.set(`${contractName}_${queue}`, stat);
        }
    }


    const genericPromises = Object.entries(genericContracts).map(
        ([contractName, contractAddress]) => _getStakeGeneric(contractName, contractAddress)
    );
    const lqPromises = Object.entries(liquidContracts).map(
        ([contractName, contractAddress]) => _getStakeLiquid(contractName, contractAddress, liquidPools[contractName].network == "testnet", liquidPools[contractName].minStake)
    );
    await Promise.all(genericPromises.concat(lqPromises));

    return result
}

async function electionsQuerySent() {
    const result = new Map<string, boolean>();
    const stakes = await getStake();

    class Elections {
        @Cacheable({
            options: { expirationTime: INTER_BLOCK_DELAY_SECONDS },
            // serialize: (r) => {return encode(r, { extensionCodec })},
            // deserialize: (e) => {return decode(e, { extensionCodec })}
            serialize: serialize,
            deserialize: deserialize
        })
        static async getElectionEntities(seqno: number, testnet: boolean) {
            const elector = getWC(testnet).openAt(seqno, new ElectorContract());
            // https://github.com/ton-blockchain/ton/blob/24dc184a2ea67f9c47042b4104bbb4d82289fac1/crypto/smartcont/elector-code.fc#L1071
            return await backoff(() => elector.getElectionEntities());
        }
    }

    async function _electionsQuerySent(contractName: string, contractAddress: Address, maxStake: number, ADNLs: string[], queue=null, testnet=false, minStake=0n) {
        const metricName = queue == null ? contractName : `${contractName}_${queue + 1}`;
        const seqno = await getWC(testnet).getLastSeqno(testnet);
        const electionEntities = await Elections.getElectionEntities(seqno, testnet);
        if (!electionEntities || !electionEntities.entities || electionEntities.entities.length == 0) {
            result.set(metricName, false);
            return
        }
        const proxyContractAddress = await backoff(() => getWC(testnet).resolveContractProxy(contractAddress, queue));
        const contractStake = stakes.get(metricName);
        var toAllocate = queue == null ? contractStake.ctx_balance : parseFloat(fromNano(getStakeToAllocateLiquid(toNano(contractStake.ctx_balance.toFixed(2)), minStake)));
        // the most stupid allocation logic. if it will fail, ther is definitely some troubles going on
        const validatorsNeeded = Math.ceil(toAllocate / maxStake);
        const querySentForADNLs = new Map<string, string>();
        for (const entitie of electionEntities.entities) {
            querySentForADNLs.set(entitie.adnl.toString('hex'), entitie.address.toString());
        }
        //const querySentForADNLs = await ADNLQueries.get(testnet);
        let quesrySentForNCurrentElectors = 0;
        for (const ADNL of ADNLs) {
            if (Array.from(querySentForADNLs.keys()).includes(ADNL.toLowerCase())) {
                if (querySentForADNLs.get(ADNL.toLowerCase()) == proxyContractAddress.toString()) {
                    quesrySentForNCurrentElectors++;
                }
            }
        }
        result.set(metricName, validatorsNeeded <= quesrySentForNCurrentElectors);
    }

    const promises = [];
    for (const pool_name of Object.keys(pools)) {
        for (const contractName of Object.keys(pools[pool_name].contracts)) {
            promises.push(_electionsQuerySent(contractName, pools[pool_name].contracts[contractName], pools[pool_name].maxStake, pools[pool_name].ADNLs))
        }
    }
    const lqTriplets = Object.entries(liquidContracts).reduce((accumulator, currentValue) => accumulator.concat([[ ...currentValue, 0], [...currentValue, 1]]), [])
    
    const lqPromises = lqTriplets.map(
        ([contractName, contractAddress, queue]) => _electionsQuerySent(
            contractName,
            contractAddress,
            liquidPools[contractName].maxStake,
            liquidPools[contractName].ADNLs, queue,
            liquidPools[contractName].network == "testnet",
            toNano(liquidPools[contractName].minStake)
        )
    );
    await Promise.all(promises.concat(lqPromises))

    return result
}

async function mustParticipateInCycle() {

    class ElectionsAddresses {
        @Cacheable({
            options: { expirationTime: INTER_BLOCK_DELAY_SECONDS},
            // serialize: (result: Address[]) => {return result.map((addr: Address) => {return addr.toString()})},
            // deserialize: (result: string[]) => {return result.map((addr: string) => {return Address.parse(addr)})}
        })
        static async get(testnet=false) {
            const seqno = await getWC(testnet).getLastSeqno(testnet);
            const srializedConfigCell = (await getWC(testnet).getConfig(seqno, [34])).config.cell;
            const currentValidators = configParseValidatorSet(loadConfigParamById(srializedConfigCell, 34).beginParse());
            const elector = getWC(testnet).openAt(seqno, new ElectorContract());
            const elections = await backoff(() => elector.getPastElections());
            const ex = elections.find(v => v.id === currentValidators!.timeSince)!;
            const validatorProxyAddresses: string[] = [];
            for (const key of currentValidators!.list!.keys()) {
                const val:{publicKey: Buffer} = currentValidators!.list!.get(key)!;
                const v = ex.frozen.get(BigInt(`0x${val.publicKey.toString('hex')}`).toString());
                validatorProxyAddresses.push(v.address.toString());
            }
            return validatorProxyAddresses
        }
    }

    const result = new Map<string, boolean>();
    async function _mustParticipateInCycle(contractName: string, contractAddress: Address, queue=null, testnet=false) {
        const proxyContractAddress = await getWC(testnet).resolveContractProxy(contractAddress, queue);
        const metricName = queue == null ? contractName : `${contractName}_${queue + 1}`
        const electionsAddresses = await ElectionsAddresses.get(testnet);
        const includes = electionsAddresses.includes(proxyContractAddress.toString());
        result.set(metricName, !includes)
    }
    const genericPromises = Object.entries(genericContracts).map(
            ([contractName, contractAddress]) => _mustParticipateInCycle(contractName, contractAddress)
    );

    const lqTriplets = Object.entries(liquidContracts).reduce((accumulator, currentValue) => accumulator.concat([[ ...currentValue, 0], [...currentValue, 1]]), [])
    const lqPromises = lqTriplets.map(
        ([contractName, contractAddress, queue]) => _mustParticipateInCycle(contractName, contractAddress, queue, liquidPools[contractName].network == "testnet")
    );

    await Promise.all(genericPromises.concat(lqPromises));

    return result
}

async function poolsSize(): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    for (const pool_name of Object.keys(pools)) {
        for (const contractName of Object.keys(pools[pool_name].contracts)) {
           result.set(contractName, pools[pool_name].ADNLs.length);
        }
    }
    for (const lq_pool_name of Object.keys(liquidPools)) {
        for (let queue = 1; queue <= 2; queue++) {
            result.set(`${lq_pool_name}_${queue}`, liquidPools[lq_pool_name].ADNLs.length)
        }

    }
    return result
}

async function unowned(){
    const result = new Map<string, number>();
    async function _getUnowned (contractName: string, contractAddress: Address, queue=null, testnet=false) {
        const ret = (await getWC(testnet).runMethodOnLastBlock(contractAddress, 'get_unowned'));
        // https://docs.ton.org/learn/tvm-instructions/tvm-exit-codes
        // 1 is !!!ALTERNATIVE!!! success exit code
        if (ret.exitCode != 0 && ret.exitCode != 1) {
            throw Error(`Got unexpextedexit code from get_unowned method call: ${ret.exitCode}`)
        }
        const metricName = queue == null ? contractName : `${contractName}_${queue + 1}`
        result.set(metricName, parseFloat(fromNano(ret.reader.readBigNumber())))
    }
    const genericPromises = Object.entries(genericContracts).map(
            ([contractName, contractAddress]) => _getUnowned(contractName, contractAddress)
    );
    const lqTriplets = Object.entries(liquidContracts).reduce((accumulator, currentValue) => accumulator.concat([[ ...currentValue, 0], [...currentValue, 1]]), [])
    const lqPromises = lqTriplets.map(
        ([contractName, contractAddress, queue]) => _getUnowned(contractName, contractAddress, queue, liquidPools[contractName].network == "testnet")
    );
    await Promise.all(genericPromises.concat(lqPromises));

    return result
}

async function controllersBalance(): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    async function _controllersBalance(contractName: string, contractAddress: Address, queue=null, testnet=false) {
        const seqno = await getWC(testnet).getLastSeqno(testnet);
        const controllerAddress = await getWC(testnet).resolveController(contractAddress);
        const balance = await getWC(testnet).getBalance(seqno, controllerAddress);
        const metricName = queue == null ? contractName : `${contractName}_${queue + 1}`
        result.set(metricName, parseFloat(fromNano(balance)));
    }
    const genericPromises = Object.entries(genericContracts).map(
            ([contractName, contractAddress]) => _controllersBalance(contractName, contractAddress)
    );
    const lqTriplets = Object.entries(liquidContracts).reduce((accumulator, currentValue) => accumulator.concat([[ ...currentValue, 0], [...currentValue, 1]]), [])
    const lqPromises = lqTriplets.map(
        ([contractName, contractAddress, queue]) => _controllersBalance(contractName, contractAddress, queue, liquidPools[contractName].network == "testnet")
    );
    await Promise.all(genericPromises.concat(lqPromises));

    return result
}

async function getValidatorsStats(): Promise<{quantity: number, totalStake: number}> {
    const seqno = await getWC(false).getLastSeqno(false);
    const srializedConfigCell = (await getWC().getConfig(seqno, [34])).config.cell;
    const currentValidators = configParseValidatorSet(loadConfigParamById(srializedConfigCell, 34).beginParse());
    const elector = getWC().open(new ElectorContract());
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
    const seqno = await getWC(false).getLastSeqno(false);
    const srializedConfigCell = (await getWC().getConfig(seqno, [15, 34, 36])).config.cell;
    const config15 = configParse15(loadConfigParamById(srializedConfigCell, 15).beginParse());
    const currentValidators = configParseValidatorSet(loadConfigParamById(srializedConfigCell, 34).beginParse());
    const config36Raw = loadConfigParamById(srializedConfigCell, 36)
    const nextValidators = config36Raw ? configParseValidatorSet(config36Raw.beginParse()) : {timeSince: null};
    const startWorkTimeNext = nextValidators?.timeSince || false;
    const startWorkTimeCurrent = currentValidators!.timeSince;
    const elector = getWC().open(new ElectorContract());
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