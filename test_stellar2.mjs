import { Asset, Operation, TransactionBuilder, Keypair, Networks, BASE_FEE, Account } from '@stellar/stellar-sdk';

const native = Asset.native();
const kp = Keypair.random();
const account = new Account(kp.publicKey(), '0');

const op = Operation.createClaimableBalance({
  asset: native,
  amount: '10',
  claimants: [{ destination: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF', predicate: { type: 'unconditional' } }],
  source: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
});

console.log('Operation created:', op);

try {
  const tx = new TransactionBuilder(new Account('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF', '0'), {
    fee: 100,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(op)
    .setTimeout(180)
    .build();
  
  console.log('Transaction built successfully');
} catch(e) {
  console.log('Error:', e.message);
}