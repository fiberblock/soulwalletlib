/*
 * @Description: 
 * @Version: 1.0
 * @Autor: z.cejay@gmail.com
 * @Date: 2022-09-21 20:28:54
 * @LastEditors: cejay
 * @LastEditTime: 2023-03-28 02:04:36
 */

import { UserOperation } from "../entity/userOperation";
import { SoulWalletContract } from "../contracts/soulWallet";
import { BigNumber, ContractInterface, ethers } from "ethers";
import { GuardianMultiSigWallet } from "../contracts/guardianMultiSigWallet";
import { WalletProxyContract } from "../contracts/walletProxy";
import { BytesLike, defaultAbiCoder, getCreate2Address, keccak256 } from "ethers/lib/utils";
import { AddressZero } from "../defines/address";
import { NumberLike, toNumber } from "../defines/numberLike";
import { SignatureMode, Signatures } from "./signatures";


/**
 * guardian class
 * @class Guardian
 */
export class Guardian {

    private _singletonFactory: string;

    /**
     * Creates an instance of Guardian.
     * @param {string} singletonFactory singleton factory address
     * @constructor
     * @returns {Guardian}
     */
    constructor(singletonFactory: string) {
        this._singletonFactory = singletonFactory;
    }

    private getInitializeData(guardians: string[], threshold: number) {
        // function initialize(address[] calldata _guardians, uint16 _threshold)
        // order by guardians asc
        // For user experience, guardian cannot rely on the order of address
        guardians.sort((a, b) => {
            const aBig = BigNumber.from(a);
            const bBig = BigNumber.from(b);
            if (aBig.eq(bBig)) {
                throw new Error(`guardian address is same: ${a}`);
            } else if (aBig.lt(bBig)) {
                return -1;
            } else {
                return 1;
            }
        });

        let iface = new ethers.utils.Interface(GuardianMultiSigWallet.ABI);
        let initializeData = iface.encodeFunctionData("initialize", [guardians, threshold]);
        return initializeData;
    }

    private getGuardianCode(guardianLogicAddress: string, guardians: string[], threshold: number, guardianProxyConfig?: {
        contractInterface: ContractInterface,
        bytecode: BytesLike | { object: string }
    }): string {
        if (!guardianProxyConfig) {
            guardianProxyConfig = {
                contractInterface: WalletProxyContract.ABI,
                bytecode: WalletProxyContract.bytecode
            }
        }
        const initializeData = this.getInitializeData(guardians, threshold);
        const factory = new ethers.ContractFactory(guardianProxyConfig.contractInterface, guardianProxyConfig.bytecode);
        const walletBytecode = factory.getDeployTransaction(guardianLogicAddress, initializeData).data;
        return walletBytecode as string;
    }

    private getPackedInitCode(create2Factory: string, initCode: string, salt: string) {
        const abi = { "inputs": [{ "internalType": "bytes", "name": "_initCode", "type": "bytes" }, { "internalType": "bytes32", "name": "_salt", "type": "bytes32" }], "name": "deploy", "outputs": [{ "internalType": "address payable", "name": "createdContract", "type": "address" }], "stateMutability": "nonpayable", "type": "function" };
        let iface = new ethers.utils.Interface([abi]);
        let packedInitCode = iface.encodeFunctionData("deploy", [initCode, salt]).substring(2);
        return create2Factory.toLowerCase() + packedInitCode;
    }

    /**
     * sign a user operation with guardian signatures
     * @param {Number} validAfter valid after (block time)
     * @param {Number} validUntil valid until (block time)
     * @param {guardianSignature[]} signatures guardian signatures
     * @param {string} guardianLogicAddress guardian logic contract address
     * @param {string[]} guardians guardian addresses
     * @param {Number} threshold threshold
     * @param {string} salt salt
     * @param {string} [guardianAddress] guardian contract address,if provided will check if equal to the calculated guardian address
     * @returns {string} signature
     */
    public packGuardiansSign(
        validAfter: number,
        validUntil: number,
        signature: guardianSignature[],
        guardianLogicAddress: string, guardians: string[],
        threshold: number, salt: string,
        guardianAddress?: string
    ): string {
        const guardianData = this.calculateGuardianAndInitCode(guardianLogicAddress, guardians, threshold, salt);
        if (guardianAddress) {
            if (guardianData.address != guardianAddress) {
                throw new Error('guardianAddress is not equal to the calculated guardian address');
            }
        }
        return this.packGuardiansSignByInitCode(guardianData.address, signature, guardianData.initCode, validAfter, validUntil);
    }

    /**
     * sign a user operation with guardian signatures
     *
     * @param {string} guardianAddress
     * @param {guardianSignature[]} signature
     * @param {string} [initCode='0x']
     * @param {number} [validAfter=0]
     * @param {number} [validUntil=0]
     * @return {*}  {string}
     * @memberof Guardian
     */
    public packGuardiansSignByInitCode(guardianAddress: string, signature: guardianSignature[], initCode = '0x', validAfter = 0, validUntil = 0
    ): string {
        const signatureBytes = this.guardianSign(signature);
        const guardianCallData = defaultAbiCoder.encode(['bytes', 'bytes'], [signatureBytes, initCode]);
        return Signatures.encodeSignature(SignatureMode.guardian, guardianAddress, guardianCallData, validAfter, validUntil);
    }


    /**
     * calculate Guardian address and deploy code (initCode)
     * @param {String} guardianLogicAddress guardian logic contract address
     * @param {String[]} guardians guardian addresses
     * @param {Number} threshold threshold
     * @param {String} salt salt
     * @returns {String,String} address is the guardian contract address,initCode is the deploy code
     */
    public calculateGuardianAndInitCode(guardianLogicAddress: string, guardians: string[], threshold: number, salt: string) {
        // check if salt is bytes32 (length 66, starts with 0x, and is hex(0-9 a-f))
        if (/^0x[a-f0-9]{64}$/.test(salt) === false) {
            // salt to bytes32
            salt = keccak256(defaultAbiCoder.encode(['string'], [salt]));
        }
        const initCodeWithArgs = this.getGuardianCode(guardianLogicAddress, guardians, threshold);
        const initCodeHash = keccak256(initCodeWithArgs);
        const address = getCreate2Address(this._singletonFactory, salt, initCodeHash);
        const initCode = this.getPackedInitCode(this._singletonFactory, initCodeWithArgs, salt);
        return {
            address,
            initCode
        };
    }

    private walletContract(etherProvider: ethers.providers.BaseProvider, walletAddress: string) {
        return new ethers.Contract(walletAddress, SoulWalletContract.ABI, etherProvider);
    }

    /**
     * get guardian info
     * @param {ethers.providers.BaseProvider} etherProvider
     * @param {String} walletAddress  wallet address
     * @param {Number} [now=0] current timestamp ( 0: use current timestamp, >0:unix timestamp  )
     * @returns {Promise<{currentGuardian:String,guardianDelay:Number}>} (currentGuardian, guardianDelay)
     */
    public async getGuardian(etherProvider: ethers.providers.BaseProvider, walletAddress: string, now: number = 0) {
        const walletContract = this.walletContract(etherProvider, walletAddress);

        const result = await etherProvider.call({
            from: AddressZero,
            to: walletAddress,
            data: new ethers.utils.Interface(SoulWalletContract.ABI).encodeFunctionData("guardianInfo", []),
        });
        const decoded = new ethers.utils.Interface(SoulWalletContract.ABI).decodeFunctionResult("guardianInfo", result);
        /* 
        
0:'0x0000000000000000000000000000000000000000'
1:'0x0000000000000000000000000000000000000000'
2:BigNumber {_hex: '0x00', _isBigNumber: true}
3:10
        */
        if (!Array.isArray(decoded) || decoded.length != 4) {
            return null;
        }
        const activateTime = decoded[2].toNumber();
        let currentGuardian = decoded[0];
        const tsNow = now > 0 ? now : Math.round(new Date().getTime() / 1000);
        if (activateTime > 0 && activateTime <= tsNow) {
            currentGuardian = decoded[1];
        }
        return {
            currentGuardian: ethers.utils.getAddress(currentGuardian),
            nextGuardian: ethers.utils.getAddress(decoded[1]),
            nextGuardianActivateTime: activateTime,
            guardianDelay: parseInt(decoded[3]),
        }
    }


    private _guardian(walletAddress: string, nonce: NumberLike,
        paymasterAndData: string,
        maxFeePerGas: NumberLike, maxPriorityFeePerGas: NumberLike, callData: string) {

        walletAddress = ethers.utils.getAddress(walletAddress);
        let userOperation: UserOperation = new UserOperation(
            walletAddress, nonce, undefined, callData, undefined, maxFeePerGas, maxPriorityFeePerGas, paymasterAndData
        );
        // let gasEstimated = await userOperation.estimateGas(entryPointAddress, etherProvider);
        // if (!gasEstimated) {
        //     return null;
        // }

        return userOperation;
    }

    /**
     * set guardian
     * @param {String} walletAddress wallet address
     * @param {String} guardian new guardian address
     * @param {Number} nonce nonce
     * @param {String} paymasterAddress paymaster address
     * @param {Number} maxFeePerGas max fee per gas
     * @param {Number} maxPriorityFeePerGas max priority fee per gas
     * @returns {Promise<UserOperation>} userOperation
     */
    public setGuardian(walletAddress: string, guardian: string,
        nonce: NumberLike, paymasterAddress: string, maxFeePerGas: NumberLike, maxPriorityFeePerGas: NumberLike) {
        guardian = ethers.utils.getAddress(guardian);

        const iface = new ethers.utils.Interface(SoulWalletContract.ABI);
        const calldata = iface.encodeFunctionData("setGuardian", [guardian]);

        return this._guardian(walletAddress, nonce, paymasterAddress,
            maxFeePerGas, maxPriorityFeePerGas, calldata);
    }

    /**
     * transfer owner
     * @param {String} walletAddress wallet address
     * @param {Number} nonce nonce
     * @param {String} paymasterAddress paymaster address
     * @param {Number} maxFeePerGas max fee per gas
     * @param {Number} maxPriorityFeePerGas max priority fee per gas
     * @param {String} newOwner new owner address
     * @returns {Promise<UserOperation>} userOperation
     */
    public transferOwner(walletAddress: string,
        nonce: NumberLike, paymasterAddress: string,
        maxFeePerGas: NumberLike, maxPriorityFeePerGas: NumberLike, newOwner: string) {
        newOwner = ethers.utils.getAddress(newOwner);

        const iface = new ethers.utils.Interface(SoulWalletContract.ABI);
        const calldata = iface.encodeFunctionData("transferOwner", [newOwner]);

        const op = this._guardian(walletAddress, nonce, paymasterAddress,
            maxFeePerGas, maxPriorityFeePerGas, calldata);

        return op;
    }

    /**
     * pack guardian signature
     * @param {guardianSignature[]} signature
     * @returns {String} packed signature
     */
    public guardianSign(
        signature: guardianSignature[]
    ): string {
        if (signature.length === 0) {
            throw new Error("signature is empty");
        }
        signature.sort((a, b) => {
            return BigNumber.from(a.address).lt(BigNumber.from(b.address)) ? -1 : 1;
        });
        let guardianSignature = [];
        let contractWalletCount = 0;
        for (let i = 0; i < signature.length; i++) {
            const signatureItem = signature[i];
            signatureItem.address = signatureItem.address.toLocaleLowerCase();
            signatureItem.signature = signatureItem.signature.toLocaleLowerCase();
            if (signatureItem.signature.startsWith('0x')) {
                signatureItem.signature = signatureItem.signature.slice(2)
            }
            if (signatureItem.contract) {
                const r = `000000000000000000000000${signatureItem.address.slice(2)}`;
                const s = ethers.utils
                    .hexZeroPad(
                        ethers.utils.hexlify(
                            (65 * signature.length) + ((contractWalletCount++) * (32 + 65))),
                        32)
                    .slice(2);
                const v = `00`;
                const _signature = {
                    signer: signatureItem.address,
                    rsvSig: `${r}${s}${v}`,
                    offsetSig: `${
                        ethers.utils
                            .hexZeroPad(
                                ethers.utils.hexlify(
                                    signatureItem.signature.length / 2), 32)
                            .slice(2)
                        }${signatureItem.signature}`,
                };
                guardianSignature.push(_signature);
            } else {
                let _signature = {
                    signer: signatureItem.address,
                    rsvSig: signatureItem.signature,
                    offsetSig: ''
                };
                guardianSignature.push(_signature);
            }
        }
        let signatureBytes = "0x";
        for (const sig of guardianSignature) {
            signatureBytes += sig.rsvSig;
        }
        for (const sig of guardianSignature) {
            signatureBytes += sig.offsetSig;
        }
        return signatureBytes;
    }

}

/**
 * guardian signature
 * @interface guardianSignature
 * @property {boolean} contract is contract wallet
 * @property {string} address guardian address
 * @property {string} signature guardian signature
 */
export interface guardianSignature {
    contract: boolean;
    address: string;
    signature: string;
}

