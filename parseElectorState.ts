import { Cell, Address, TonClient4, Dictionary, fromNano } from "@ton/ton";
async function main() {
    const client = new TonClient4({ endpoint: "https://mainnet-v4.tonhubapi.com" })
    //const seqno = (await client.getLastBlock()).last.seqno - 3000;
    const seqno = (await client.getLastBlock()).last.seqno
    //const seqno = 39997575 -1000;
    const account = await client.getAccount(seqno, Address.parse("Ef8zMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzM0vF"));
    if (account.account.state.type != "active") {
        return
    }
    const data = Cell.fromBase64(account.account.state.data!).beginParse();
    const electCell = data.loadMaybeRef();
    const elect = electCell?.beginParse();
    const elect_at = elect?.loadUint(32);
    const elect_close = elect?.loadUint(32);
    const min_stake = elect?.loadCoins();
    const total_stake = elect?.loadCoins();
    const members = elect?.loadDict(Dictionary.Keys.BigInt(256), {
        serialize: () => {},
        parse: (slice) => {
            return {
                stake: slice.loadCoins(),
                time: slice.loadUint(32),
                max_factor: slice.loadUint(32),
                src_addr: slice.loadUintBig(256),
                adnl_addr: slice.loadUintBig(256),
            };
        }
    });

    //console.log(members?.keys().map((e) => e.toString(16)));
    const ADNLs = ["AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"];
    const membersADNLs = JSON.stringify(members?.values().map(e => (e.adnl_addr.toString(16))));
    // ADNLs.forEach(adnl => {
    //     console.log(`adnl: ${adnl}: ${membersADNLs.includes(adnl.toLowerCase())}`);
    // });
    const credits = data?.loadDict(Dictionary.Keys.BigUint(256), {
        serialize: () => {},
        parse: (slice) => {
            return slice.loadCoins()
        }
    });
    //console.log(credits)
    for (const [addrInt, amount] of credits) {
        console.log(Address.parseRaw("-1:" + addrInt.toString(16).padStart(64, "0")), fromNano(amount))
    }

}
main()