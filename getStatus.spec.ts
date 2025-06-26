import { Address } from "@ton/core";
import { poolLostElections, setOverrideSeqno, overrideConfig, serialize, deserialize } from "./getStatus"


const mapToObject = (map: any) => Object.fromEntries(map.entries());

describe('metrics', () => {
    it('should ensure round loss', async () => {
        
        overrideConfig({}, {}, {
            "Whales Nominators #1": Address.parse("EQCkR1cGmnsE45N4K0otPl5EnxnRakmGqeJUNua5fkWhales"),
            "Whales Nominators #2": Address.parse("EQCY4M6TZYnOMnGBQlqi_nyeaIB1LeBFfGgP4uXQ1VWhales"),
            "Morgen #1": Address.parse("EQB163rv0MDNK0Pdl6a6vPd1IOTF7cMzvZEjvxCSUcQMafia"),
            "tonkeeper #1": Address.parse("EQAA_5_dizuA1w6OpzTSYvXhvUwYTDNTW_MZDdZ0CGKeeper"),
            "tonkeeper #2": Address.parse("EQDvvBmP3wUcjoXPY1jHfT4-fgb294imVYH5EHdLnAKeeper")
        }, {})
        setOverrideSeqno(39502071, 22472603);
        const result = mapToObject(await poolLostElections())
        expect(result).toMatchObject({
            'Whales Nominators #1': false,
            'Morgen #1': true,
            'tonkeeper #2': false,
            'Whales Nominators #2': false,
            'tonkeeper #1': true
        })
    });

//     it('example of poolsConfig override', async () => {
        
//         overrideConfig(
//             {"main": {
//                 maxStake: 1,
//                 contracts: new Map(Object.entries({
//                     "Whales Nominators #1": (Address.parse("EQCkR1cGmnsE45N4K0otPl5EnxnRakmGqeJUNua5fkWhales") as any),
//                     "Whales Nominators #2": (Address.parse("EQCY4M6TZYnOMnGBQlqi_nyeaIB1LeBFfGgP4uXQ1VWhales") as any)
//                 })),
//                 ADNLs: ["a"]
//             },
//             "morgen": {
//                 maxStake: 1,
//                 contracts: new Map(Object.entries({
//                     "Morgen #1": (Address.parse("EQB163rv0MDNK0Pdl6a6vPd1IOTF7cMzvZEjvxCSUcQMafia") as any),
//                 })),
//                 ADNLs: ["a"]
//             },
//             "tonkeeper": {
//                 maxStake: 1,
//                 contracts: new Map(Object.entries({
//                     "tonkeeper #1": (Address.parse("EQAA_5_dizuA1w6OpzTSYvXhvUwYTDNTW_MZDdZ0CGKeeper") as any),
//                     "tonkeeper #2": (Address.parse("EQDvvBmP3wUcjoXPY1jHfT4-fgb294imVYH5EHdLnAKeeper") as any)
//                 })),
//                 ADNLs: ["a"]
//             },
//             },
//             {},
//             {},
//             {}
//         )
//         setOverrideSeqno(39502071, 22472603);
//         console.log(await poolLostElections())
//     });
});

describe('Buffer and Uint8Array serialization', () => {
    test('should maintain type consistency after serialization', () => {
        const hexString = 'aac2d4e950ce00189b6cd2e9f9e25876e082d23af83a177d827fcad8918f3163';
        const buffer = Buffer.from(hexString, 'hex');
        const uint8Array = new Uint8Array(Buffer.from(hexString, 'hex'));

        const mockElectionEntity = {
            adnl: buffer,
            address: 'test'
        };

        const mockElectionEntityUint8 = {
            adnl: uint8Array,
            address: 'test'
        };

        const serializedBuffer = serialize(mockElectionEntity);
        const deserializedBuffer = deserialize(serializedBuffer) as any;

        const serializedUint8 = serialize(mockElectionEntityUint8);
        const deserializedUint8 = deserialize(serializedUint8) as any;

        expect(deserializedBuffer.adnl.toString('hex')).toBe(hexString);
        expect(Buffer.isBuffer(deserializedBuffer.adnl)).toBe(true);

        expect(deserializedUint8.adnl instanceof Uint8Array).toBe(true);
        expect(!Buffer.isBuffer(deserializedUint8.adnl)).toBe(true);
        expect(Buffer.from(deserializedUint8.adnl).toString('hex')).toBe(hexString);
    });
});