import { HDNodeWallet, Mnemonic, Wallet } from "ethers";
import { encrypt, decrypt, type EncryptedBlob } from "./crypto";

const DERIVATION_PATH = "m/44'/60'/0'/0";

export type WalletRecord = {
  id: string;
  name: string;
  address: string;
  createdAt: number;
  source: "mnemonic" | "privateKey";
  encrypted: EncryptedBlob;
};

export type WalletWithSecret = WalletRecord & {
  secret: string;
};

function newId(): string {
  return `w_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function createMnemonicWallet(name: string, password: string, index = 0): WalletWithSecret {
  const mnemonic = Mnemonic.fromEntropy(crypto.getRandomValues(new Uint8Array(16)));
  const path = `${DERIVATION_PATH}/${index}`;
  const hdNode = HDNodeWallet.fromMnemonic(mnemonic, path);
  return buildRecord(name, hdNode.address, mnemonic.phrase, "mnemonic", password);
}

export function importMnemonicWallet(
  name: string,
  phrase: string,
  password: string,
  index = 0
): WalletWithSecret {
  const mnemonic = Mnemonic.fromPhrase(phrase.trim());
  const hdNode = HDNodeWallet.fromMnemonic(mnemonic, `${DERIVATION_PATH}/${index}`);
  return buildRecord(name, hdNode.address, mnemonic.phrase, "mnemonic", password);
}

export function importPrivateKeyWallet(
  name: string,
  privateKey: string,
  password: string
): WalletWithSecret {
  const wallet = new Wallet(privateKey.trim().startsWith("0x") ? privateKey.trim() : `0x${privateKey.trim()}`);
  return buildRecord(name, wallet.address, wallet.privateKey, "privateKey", password);
}

function buildRecord(
  name: string,
  address: string,
  secret: string,
  source: WalletRecord["source"],
  password: string
): WalletWithSecret {
  return {
    id: newId(),
    name,
    address,
    createdAt: Date.now(),
    source,
    encrypted: encrypt(secret, password),
    secret
  };
}

export function unlockWallet(record: WalletRecord, password: string): string {
  return decrypt(record.encrypted, password);
}

export function deriveSigner(secret: string, source: WalletRecord["source"]): Wallet | HDNodeWallet {
  if (source === "mnemonic") {
    return HDNodeWallet.fromMnemonic(Mnemonic.fromPhrase(secret), `${DERIVATION_PATH}/0`);
  }
  return new Wallet(secret);
}
