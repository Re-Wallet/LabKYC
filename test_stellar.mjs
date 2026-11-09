import { Asset, Operation, TransactionBuilder, Keypair, Networks, BASE_FEE, Account } from '@stellar/stellar-sdk';

const native = Asset.native();
const kp = Keypair.random();
const account = new Account(kp.publicKey(), '0');

try {
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.createClaimableBalance({
      asset: native,
      amount: '10',
      claimants: [{ destination: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF', predicate: { type: 'unconditional' } }],
      source: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
    })
    .setTimeout(180)
    .build();
  
  console.log('Transaction built successfully');
} catch(e) {
  console.log('Error:', e.message);
}