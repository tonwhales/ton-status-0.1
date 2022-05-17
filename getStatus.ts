import { Address, TonClient } from "ton";
import { ElectorContract } from "ton-contracts";
import BN from "bn.js";
import { createBackoff } from "teslabot";
import yargs from "yargs/yargs";

let client = new TonClient({ endpoint: "https://mainnet.tonhubapi.com/jsonRPC"});
let address = Address.parse('EQCkR1cGmnsE45N4K0otPl5EnxnRakmGqeJUNua5fkWhales');

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
    let startElection = configs.validatorSets.currentValidators!.timeSince - configs.validators.electorsStartBefore;
    let endElection = configs.validatorSets.currentValidators!.timeSince - configs.validators.electorsEndBefore;
    let currentTimeInSeconds = Math.floor(Date.now() / 1000);
    let timeBeforeElectionsEnd = endElection - currentTimeInSeconds;
    if (timeBeforeElectionsEnd < 0) {
        timeBeforeElectionsEnd = 86400;
    }
    return {"timeBeforeElectionsEnd": timeBeforeElectionsEnd}
}

function print(msg: any) {
    process.stdout.write(JSON.stringify(msg) + "\n");
}

yargs(process.argv.slice(2))
    .usage('Usage: $0 <command>')
    .command('complaints', 'Get validator complaints', () => {}, async () => {print(await getComplaintsAddresses())})
    .command('staking', 'Get status of stakes', () => {}, async () => {print(await getStakingState())})
    .command('election-ends-in', 'Seconds before elections end or 86400 if no elections active', () => {}, async () => {print(await getTimeBeforeElectionEnd())})
    .demandCommand()
    .help('h')
    .alias('h', 'help')
    .argv;
