import fs from 'fs';
import { Address, TonClient, TonClient4, Traits } from "ton";
import { createLocalExecutor } from "ton-nodejs";
import { ElectorContract } from "ton-contracts";
import BN from "bn.js";
import { createBackoff } from "teslabot";
import yargs from "yargs/yargs";

let client = new TonClient({ endpoint: "https://mainnet.tonhubapi.com/jsonRPC"});
let address = Address.parse('EQCkR1cGmnsE45N4K0otPl5EnxnRakmGqeJUNua5fkWhales');
let pool2Address = Address.parse('EQCY4M6TZYnOMnGBQlqi_nyeaIB1LeBFfGgP4uXQ1VWhales');

const backoff = createBackoff({ onError: (e, i) => i > 3 && console.warn(e) });

function parseHex(src: string): BN {
    if (src.startsWith('-')) {
        let res = parseHex(src.slice(1));
        return res.neg();
    }
    return new BN(src.slice(2), 'hex');
}

async function getStakingState() {
    let response = await backoff(() => client.callGetMethod(address, 'get_staking_status', []));
    let stakeAt = parseHex(response.stack[0][1] as string).toNumber();
    let stakeUntil = parseHex(response.stack[1][1] as string).toNumber();
    let stakeSent = parseHex(response.stack[2][1] as string);
    let querySent = parseHex(response.stack[3][1] as string).toNumber() === -1;
    let couldUnlock = parseHex(response.stack[4][1] as string).toNumber() === -1;
    let locked = parseHex(response.stack[5][1] as string).toNumber() === -1;
    return {
        stakeAt,
        stakeUntil,
        stakeSent,
        querySent,
        couldUnlock,
        locked
    }
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
        for (let c of complaints) {
            let address = complaintsElections.frozen.get(new BN(c.publicKey, 'hex').toString())!.address;
            if (address.toFriendly().endsWith("Whales")) {
                complaintsList.push(address.toFriendly());
            }
        }
        return {"success": true, msg: "", payload: complaintsList}

    }
    catch(e) {
       return {"success": false, msg: "Execution failed: " + (e as any).message, payload:[]}
    }
}

async function getTimeBeforeElectionEnd() {
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
    return {"timeBeforeElectionsEnd": timeBeforeElectionsEnd}
}

function bnNanoTONsToTons(bn: BN): number {
    return bn.div(new BN('1000000000', 10)).toNumber()
}

async function getStake(){
    let c = new TonClient4({endpoint: "https://mainnet-v4.tonhubapi.com"});
    const block = (await c.getLastBlock()).last.seqno;
    let executor = await createLocalExecutor(c, block, address);
    let status = (await executor.run('get_pool_status'));
    let ctx_balance =                  bnNanoTONsToTons(status.stack.readBigNumber());
    let ctx_balance_sent =             bnNanoTONsToTons(status.stack.readBigNumber());
    let ctx_balance_pending_deposits = bnNanoTONsToTons(status.stack.readBigNumber());
    let ctx_balance_pending_withdraw = bnNanoTONsToTons(status.stack.readBigNumber());
    let ctx_balance_withdraw =         bnNanoTONsToTons(status.stack.readBigNumber());
    let steak_for_next_elections =     ctx_balance + ctx_balance_pending_deposits;
    let executor2 = await createLocalExecutor(c, block, pool2Address);
    let status2 = (await executor2.run('get_pool_status'));
    let ctx_balance2 =                  bnNanoTONsToTons(status2.stack.readBigNumber());
    let ctx_balance_sent2 =             bnNanoTONsToTons(status2.stack.readBigNumber());
    let ctx_balance_pending_deposits2 = bnNanoTONsToTons(status2.stack.readBigNumber());
    let steak_for_next_elections2 =     ctx_balance2 + ctx_balance_pending_deposits2;
    return {"ctx_balance": ctx_balance,
            "ctx_balance_sent": ctx_balance_sent,
            "ctx_balance_pending_deposits": ctx_balance_pending_deposits,
            "ctx_balance_pending_withdraw": ctx_balance_pending_withdraw,
            "ctx_balance_withdraw": ctx_balance_withdraw,
            "steak_for_next_elections": steak_for_next_elections,
            "steak_for_next_elections_pool2": steak_for_next_elections2}
}


async function electionsQuerySent() {
    let elector = await new ElectorContract(client);
    // https://github.com/ton-blockchain/ton/blob/24dc184a2ea67f9c47042b4104bbb4d82289fac1/crypto/smartcont/elector-code.fc#L1071
    let electionEntities = await elector.getElectionEntities();
    if (electionEntities.entities.length == 0) {
        return {"elections_query_sent": false}
    }
    let querySentForADNLs = electionEntities.entities.map(e => e.adnl.toString('hex'));
    let pool1ValidatorADNLs = JSON.parse(fs.readFileSync('/etc/ton-status/config.json', 'utf-8')).pool1ValidatorADNLs;
    for (let ADNL of pool1ValidatorADNLs) {
        if (!querySentForADNLs.includes(ADNL.toLowerCase())) {
            return {"elections_query_sent": false}
        }
    }
    return {"elections_query_sent": true}
}


async function mustParticipateInCycle() {
    let configs = await client.services.configs.getConfigs();
    let currentValidatorADNLs = Array.from(configs.validatorSets.currentValidators.list.values()).map(a => a.adnlAddress.toString("hex"));
    let pool1ValidatorADNLs = JSON.parse(fs.readFileSync('/etc/ton-status/config.json', 'utf-8')).pool1ValidatorADNLs;
    let validatorsInCurrCycle = 0;
    for (let ADNL of pool1ValidatorADNLs) {
        if (currentValidatorADNLs.includes(ADNL.toLowerCase())) {
            validatorsInCurrCycle++;
        }
    }
    // if ADNLs are in current cycle, next cycle we will skip
    return {"must_participate_in_cycle": (validatorsInCurrCycle >= (pool1ValidatorADNLs.length / 2)) ? false : true}
}

async function getPoolsSize() {
    let pool1ValidatorADNLs = JSON.parse(fs.readFileSync('/etc/ton-status/config.json', 'utf-8')).pool1ValidatorADNLs;
    return {"pool_1_length": pool1ValidatorADNLs.length}
}

//TODO: implement func that returns validators indexes (probably not here?)


function print(msg: any) {
    process.stdout.write(JSON.stringify(msg) + "\n");
}

yargs(process.argv.slice(2))
    .usage('Usage: $0 <command>')
    .command('complaints', 'Get validator complaints', () => {}, async () => {print(await getComplaintsAddresses())})
    .command('staking', 'Get status of stakes', () => {}, async () => {print(await getStakingState())})
    .command('election-ends-in', 'Seconds before elections end or 86400 if no elections active', () => {}, async () => {print(await getTimeBeforeElectionEnd())})
    .command('get-stake', "Returns detailed information about stake status", () => {}, async () => {print(await getStake())})
    .command('election-queries-sent', "Checks if elections query for current ellections has been sent", () => {}, async () => {print(await electionsQuerySent())})
    .command('must-participate-in-cycle', "For old logic with participation in every second cycle", () => {}, async () => {print(await mustParticipateInCycle())})
    .command('get-pools-size', "Returns quantity of validators in corresponding pool", () => {}, async () => {print(await getPoolsSize())})
    .demandCommand()
    .help('h')
    .alias('h', 'help')
    .argv;

