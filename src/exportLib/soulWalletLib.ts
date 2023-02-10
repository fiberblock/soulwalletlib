/*
 * @Description: 
 * @Version: 1.0
 * @Autor: z.cejay@gmail.com
 * @Date: 2022-08-05 16:08:23
 * @LastEditors: cejay
 * @LastEditTime: 2023-02-09 18:44:06
 */

import { getCreate2Address, hexlify, hexZeroPad, keccak256, defaultAbiCoder } from "ethers/lib/utils";
import * as addressDefine from "../defines/address";
import { UserOperation } from "../entity/userOperation";
import { IContract } from "../contracts/icontract";
import { SimpleWalletContract } from "../contracts/soulWallet";
import { WalletProxyContract } from "../contracts/walletProxy";
import { TokenPaymasterContract } from "../contracts/tokenPaymaster";
import { DecodeCallData } from '../utils/decodeCallData';
import { Guardian } from "../utils/guardian";
import { ERC1155, ERC20, ERC721, ETH } from "../utils/token";
import { Bundler } from '../utils/bundler';
import { Converter } from "../utils/converter";
import { BigNumber, ethers } from "ethers";
import { NumberLike } from "../defines/numberLike";
import { CodefiGasFees } from '../utils/gasFee';
import { TokenAndPaymaster } from '../utils/tokenAndPaymaster';
import { DeployFactory } from '../utils/deployFactory';
import { bytes32_zero } from "../defines/bytes32";
import { WalletFactoryContract } from "../contracts/walletFactory";
import { SingletonFactoryAddress } from "../defines/address";

export class SoulWalletLib {

    private _singletonFactory;
    private _deployFactory;

    public Utils;

    public static Defines = addressDefine;

    public Guardian: Guardian;

    public Tokens;


    constructor(singletonFactory?: string) {
        singletonFactory = singletonFactory || SingletonFactoryAddress;
        
        this._singletonFactory = singletonFactory;
        this._deployFactory = new DeployFactory(singletonFactory);

        this.Utils = {
            getNonce: this.getNonce,
            DecodeCallData: DecodeCallData,
            suggestedGasFee: CodefiGasFees,
            tokenAndPaymaster: TokenAndPaymaster,
            deployFactory: this._deployFactory,
            fromTransaction: new Converter().fromTransaction
        }

        this.Tokens = {
            ERC1155: new ERC1155(this._singletonFactory),
            ERC20: new ERC20(this._singletonFactory),
            ERC721: new ERC721(this._singletonFactory),
            ETH: new ETH(this._singletonFactory)
        }

        this.Guardian = new Guardian(this._singletonFactory);

    }

    public get singletonFactory() {
        return this._singletonFactory;
    }

    public Bundler = Bundler;


    /**
     * 
     * @param entryPointAddress the entryPoint address
     * @param ownerAddress the owner address 
     * @param upgradeDelay the upgrade delay time
     * @param guardianDelay the guardian delay time
     * @param guardianAddress the guardian contract address
     * @returns inithex
     */
    private getInitializeData(
        entryPointAddress: string,
        ownerAddress: string,
        upgradeDelay: number,
        guardianDelay: number,
        guardianAddress: string
    ) {
        // function initialize(IEntryPoint anEntryPoint, address anOwner,  IERC20 token,address paymaster)
        // encodeFunctionData
        let iface = new ethers.utils.Interface(SimpleWalletContract.ABI);
        let initializeData = iface.encodeFunctionData("initialize", [entryPointAddress, ownerAddress, upgradeDelay, guardianDelay, guardianAddress]);
        return initializeData;
    }

    /**
     * get wallet code
     * @param walletLogicAddress the wallet logic contract address
     * @param entryPointAddress the entryPoint address
     * @param ownerAddress the owner address
     * @param upgradeDelay the upgrade delay time
     * @param guardianDelay the guardian delay time
     * @param guardianAddress the guardian contract address
     * @returns the wallet code hex string  
     */
    public getWalletCode(walletLogicAddress: string, entryPointAddress: string, ownerAddress: string, upgradeDelay: number, guardianDelay: number, guardianAddress: string): string {
        const initializeData = this.getInitializeData(entryPointAddress, ownerAddress, upgradeDelay, guardianDelay, guardianAddress);
        const factory = new ethers.ContractFactory(WalletProxyContract.ABI, WalletProxyContract.bytecode);
        const walletBytecode = factory.getDeployTransaction(walletLogicAddress, initializeData).data;
        return walletBytecode as string;
    }

    /**
     * calculate wallet address by owner address
     * @param walletLogicAddress the wallet logic contract address
     * @param entryPointAddress the entryPoint address
     * @param ownerAddress the owner address 
     * @param upgradeDelay the upgrade delay time
     * @param guardianDelay the guardian delay time
     * @param guardianAddress the guardian contract address
     * @param salt the salt number,default is 0
     * @returns 
     */
    public calculateWalletAddress(
        walletLogicAddress: string,
        entryPointAddress: string,
        ownerAddress: string,
        upgradeDelay: number,
        guardianDelay: number,
        guardianAddress: string,
        salt?: number) {
        const initCodeWithArgs = this.getWalletCode(walletLogicAddress, entryPointAddress, ownerAddress, upgradeDelay, guardianDelay, guardianAddress);
        const initCodeHash = keccak256(initCodeWithArgs);
        const walletAddress = this.calculateWalletAddressByCodeHash(initCodeHash, salt);
        return walletAddress;
    }

    /**
     * get the userOperation for active (first time) the wallet
     * @param walletLogicAddress the wallet logic contract address
     * @param entryPointAddress 
     * @param ownerAddress 
     * @param upgradeDelay the upgrade delay time
     * @param guardianDelay the guardian delay time
     * @param guardianAddress the guardian contract address
     * @param paymasterAndData the paymaster address and data
     * @param maxFeePerGas the max fee per gas
     * @param maxPriorityFeePerGas the max priority fee per gas
     * @param salt the salt number,default is 0
     * @param walletProxy the walletProxy contract address
     * @param walletFactory the walletFactory contract address
     */
    public activateWalletOp(
        walletLogicAddress: string,
        entryPointAddress: string,
        ownerAddress: string,
        upgradeDelay: number,
        guardianDelay: number,
        guardianAddress: string,
        paymasterAndData: string,
        maxFeePerGas: NumberLike,
        maxPriorityFeePerGas: NumberLike,
        salt?: number,
        walletFactory?: string
    ) {
        const walletAddress = this.calculateWalletAddress(walletLogicAddress, entryPointAddress, ownerAddress, upgradeDelay, guardianDelay, guardianAddress, salt);

        const userOperation = new UserOperation();
        userOperation.nonce = 0;
        userOperation.sender = walletAddress;
        userOperation.paymasterAndData = paymasterAndData;
        userOperation.maxFeePerGas = maxFeePerGas;
        userOperation.maxPriorityFeePerGas = maxPriorityFeePerGas;
        userOperation.initCode = this.getPackedInitCodeUsingWalletFactory(
            walletFactory,
            walletLogicAddress,
            entryPointAddress,
            ownerAddress,
            upgradeDelay,
            guardianDelay,
            guardianAddress,
            salt
        );
        userOperation.callGasLimit = 0;
        userOperation.callData = "0x";
        return userOperation;
    }

    private getPackedInitCodeUsingWalletFactory(walletFactory: string | undefined, walletLogicAddress: string | undefined, entryPointAddress: string, ownerAddress: string, upgradeDelay: number, guardianDelay: number, guardianAddress: string, salt?: number) {
        let iface = new ethers.utils.Interface(WalletFactoryContract.ABI);
        let packedInitCode = iface.encodeFunctionData("createWallet",
            [
                entryPointAddress,
                ownerAddress,
                upgradeDelay,
                guardianDelay,
                guardianAddress,
                this.number2Bytes32(salt)
            ]
        ).substring(2);
        if (!walletFactory) {
            if (!walletLogicAddress) {
                throw new Error("walletLogicAddress is undefined");
            }
            walletFactory = this._deployFactory.getAddress(walletLogicAddress);
        }
        return walletFactory.toLowerCase() + packedInitCode;
    }

    public async getPaymasterExchangePrice(etherProvider: ethers.providers.BaseProvider, payMasterAddress: string, token: string): Promise<BigNumber> {
        const paymaster = new ethers.Contract(payMasterAddress, TokenPaymasterContract.ABI, etherProvider);
        if (await paymaster.isSupportedToken(token) === true) {
            const price = await paymaster.exchangePrice(token);
            return price;
        } else {
            throw new Error("token is not supported");
        }
    }

    public getPaymasterData(payMasterAddress: string, token: string, lowestPrice: BigNumber) {
        const enc = payMasterAddress.toLowerCase() + defaultAbiCoder.encode(
            ['address', 'uint256'],
            [token, lowestPrice]).substring(2)
        return enc;
    }

    /**
     * calculate EIP-4337 wallet address
     * @param initContract the init Contract
     * @param initArgs the init args
     * @param salt the salt number
     * @returns 
     */
    public calculateWalletAddressByCode(
        initContract: IContract,
        initArgs: any[] | undefined,
        salt: number): string {
        const factory = new ethers.ContractFactory(initContract.ABI, initContract.bytecode);
        const initCodeWithArgs = factory.getDeployTransaction(initArgs).data as string;
        const initCodeHash = keccak256(initCodeWithArgs);
        return this.calculateWalletAddressByCodeHash(initCodeHash, salt);

    }

    public number2Bytes32(num?: number) {
        if (num === undefined) {
            return bytes32_zero;
        }
        return hexZeroPad(hexlify(num), 32);
    }

    /**
     * calculate EIP-4337 wallet address
     * @param initCodeHash the init code after keccak256
     * @param salt the salt number
     * @returns the EIP-4337 wallet address
     */
    private calculateWalletAddressByCodeHash(
        initCodeHash: string,
        salt?: number): string {

        return getCreate2Address(this._singletonFactory,
            this.number2Bytes32(salt),
            initCodeHash);
    }


    /**
     * get nonce number from contract wallet
     * @param walletAddress the wallet address
     * @param web3 the web3 instance
     * @param defaultBlock "earliest", "latest" and "pending"
     * @returns the next nonce number
     */
    private async getNonce(walletAddress: string, etherProvider: ethers.providers.BaseProvider, defaultBlock = 'latest'): Promise<number> {
        try {
            const code = await etherProvider.getCode(walletAddress, defaultBlock);
            // check contract is exist
            if (code === '0x') {
                return 0;
            } else {
                const contract = new ethers.Contract(walletAddress, [{ "inputs": [], "name": "nonce", "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }], "stateMutability": "view", "type": "function" }], etherProvider);
                const nonce = await contract.nonce();
                // try parse to number
                const nextNonce = parseInt(nonce, 10);
                if (isNaN(nextNonce)) {
                    throw new Error('nonce is not a number');
                }
                return nextNonce;
            }

        } catch (error) {
            throw error;
        }
    }


}

export { UserOperation } from "../entity/userOperation";