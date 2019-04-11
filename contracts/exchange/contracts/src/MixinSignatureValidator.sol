/*

  Copyright 2018 ZeroEx Intl.

  Licensed under the Apache License, Version 2.0 (the "License");
  you may not use this file except in compliance with the License.
  You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing, software
  distributed under the License is distributed on an "AS IS" BASIS,
  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
  See the License for the specific language governing permissions and
  limitations under the License.

*/

pragma solidity ^0.5.5;
pragma experimental ABIEncoderV2;

import "@0x/contracts-utils/contracts/src/LibBytes.sol";
import "@0x/contracts-utils/contracts/src/ReentrancyGuard.sol";
import "./mixins/MSignatureValidator.sol";
import "./mixins/MTransactions.sol";
import "./mixins/MExchangeRichErrors.sol";
import "./interfaces/IWallet.sol";
import "./interfaces/IValidator.sol";


contract MixinSignatureValidator is
    ReentrancyGuard,
    MSignatureValidator,
    MTransactions,
    MExchangeRichErrors
{
    using LibBytes for bytes;

    // Mapping of hash => signer => signed
    mapping (bytes32 => mapping (address => bool)) public preSigned;

    // Mapping of signer => validator => approved
    mapping (address => mapping (address => bool)) public allowedValidators;

    /// @dev Approves a hash on-chain using any valid signature type.
    ///      After presigning a hash, the preSign signature type will become valid for that hash and signer.
    /// @param signerAddress Address that should have signed the given hash.
    /// @param signature Proof that the hash has been signed by signer.
    function preSign(
        bytes32 hash,
        address signerAddress,
        bytes calldata signature
    )
        external
    {
        if (signerAddress != msg.sender) {
            if (!isValidSignature(
                    hash,
                    signerAddress,
                    signature)) {
                rrevert(SignatureError(
                    SignatureErrorCodes.BAD_SIGNATURE,
                    hash,
                    signerAddress,
                    signature
                ));
            }
        }
        preSigned[hash][signerAddress] = true;
    }

    /// @dev Approves/unnapproves a Validator contract to verify signatures on signer's behalf.
    /// @param validatorAddress Address of Validator contract.
    /// @param approval Approval or disapproval of  Validator contract.
    function setSignatureValidatorApproval(
        address validatorAddress,
        bool approval
    )
        external
        nonReentrant
    {
        address signerAddress = getCurrentContextAddress();
        allowedValidators[signerAddress][validatorAddress] = approval;
        emit SignatureValidatorApproval(
            signerAddress,
            validatorAddress,
            approval
        );
    }

    /// @dev Verifies that a hash has been signed by the given signer.
    /// @param hash Any 32 byte hash.
    /// @param signerAddress Address that should have signed the given hash.
    /// @param signature Proof that the hash has been signed by signer.
    /// @return True if the address recovered from the provided signature matches the input signer address.
    function isValidSignature(
        bytes32 hash,
        address signerAddress,
        bytes memory signature
    )
        public
        view
        returns (bool isValid)
    {
        if (signature.length == 0) {
            rrevert(SignatureError(
                SignatureErrorCodes.INVALID_LENGTH,
                hash,
                signerAddress,
                signature
            ));
        }

        // Pop last byte off of signature byte array.
        uint8 signatureTypeRaw = uint8(signature[signature.length-1]);

        // Ensure signature is supported
        if (signatureTypeRaw >= uint8(SignatureType.NSignatureTypes)) {
            rrevert(SignatureError(
                SignatureErrorCodes.UNSUPPORTED,
                hash,
                signerAddress,
                signature
            ));
        }

        SignatureType signatureType = SignatureType(signatureTypeRaw);

        // Variables are not scoped in Solidity.
        uint8 v;
        bytes32 r;
        bytes32 s;
        address recovered;

        // Always illegal signature.
        // This is always an implicit option since a signer can create a
        // signature array with invalid type or length. We may as well make
        // it an explicit option. This aids testing and analysis. It is
        // also the initialization value for the enum type.
        if (signatureType == SignatureType.Illegal) {
            rrevert(SignatureError(
                SignatureErrorCodes.ILLEGAL,
                hash,
                signerAddress,
                signature
            ));

        // Always invalid signature.
        // Like Illegal, this is always implicitly available and therefore
        // offered explicitly. It can be implicitly created by providing
        // a correctly formatted but incorrect signature.
        } else if (signatureType == SignatureType.Invalid) {
            if (signature.length != 1) {
                rrevert(SignatureError(
                    SignatureErrorCodes.INVALID_LENGTH,
                    hash,
                    signerAddress,
                    signature
                ));
            }
            isValid = false;
            return isValid;

        // Signature using EIP712
        } else if (signatureType == SignatureType.EIP712) {
            if (signature.length != 66) {
                rrevert(SignatureError(
                    SignatureErrorCodes.INVALID_LENGTH,
                    hash,
                    signerAddress,
                    signature
                ));
            }
            v = uint8(signature[0]);
            r = signature.readBytes32(1);
            s = signature.readBytes32(33);
            recovered = ecrecover(
                hash,
                v,
                r,
                s
            );
            isValid = signerAddress == recovered;
            return isValid;

        // Signed using web3.eth_sign
        } else if (signatureType == SignatureType.EthSign) {
            if (signature.length != 66) {
                rrevert(SignatureError(
                    SignatureErrorCodes.INVALID_LENGTH,
                    hash,
                    signerAddress,
                    signature
                ));
            }
            v = uint8(signature[0]);
            r = signature.readBytes32(1);
            s = signature.readBytes32(33);
            recovered = ecrecover(
                keccak256(abi.encodePacked(
                    "\x19Ethereum Signed Message:\n32",
                    hash
                )),
                v,
                r,
                s
            );
            isValid = signerAddress == recovered;
            return isValid;

        // Signature verified by wallet contract.
        // If used with an order, the maker of the order is the wallet contract.
        } else if (signatureType == SignatureType.Wallet) {
            isValid = isValidWalletSignature(
                hash,
                signerAddress,
                signature
            );
            return isValid;

        // Signature verified by validator contract.
        // If used with an order, the maker of the order can still be an EOA.
        // A signature using this type should be encoded as:
        // | Offset   | Length | Contents                        |
        // | 0x00     | x      | Signature to validate           |
        // | 0x00 + x | 20     | Address of validator contract   |
        // | 0x14 + x | 1      | Signature type is always "\x06" |
        } else if (signatureType == SignatureType.Validator) {
            isValid = isValidValidatorSignature(
                hash,
                signerAddress,
                signature
            );
            return isValid;

        // Signer signed hash previously using the preSign function.
        } else if (signatureType == SignatureType.PreSigned) {
            isValid = preSigned[hash][signerAddress];
            return isValid;
        }

        // Anything else is illegal (We do not return false because
        // the signature may actually be valid, just not in a format
        // that we currently support. In this case returning false
        // may lead the caller to incorrectly believe that the
        // signature was invalid.)
        rrevert(SignatureError(
            SignatureErrorCodes.UNSUPPORTED,
            hash,
            signerAddress,
            signature
        ));
    }

    /// @dev Verifies signature using logic defined by Wallet contract.
    /// @param hash Any 32 byte hash.
    /// @param walletAddress Address that should have signed the given hash
    ///                      and defines its own signature verification method.
    /// @param signature Proof that the hash has been signed by signer.
    /// @return True if signature is valid for given wallet..
    function isValidWalletSignature(
        bytes32 hash,
        address walletAddress,
        bytes memory signature
    )
        private
        view
        returns (bool isValid)
    {
        uint256 signatureLength = signature.length;
        // Shave the signature type off the signature.
        assembly {
            mstore(signature, sub(signatureLength, 1))
        }

        // Encode the call data.
        bytes memory callData = abi.encodeWithSelector(
            IWallet(walletAddress).isValidSignature.selector,
            hash,
            signature
        );
        // Static call the verification function.
        (bool didSucceed, bytes memory returnData) = walletAddress.staticcall(callData);
        // Return data should be a single bool.
        if (didSucceed && returnData.length == 32)
            return returnData.readUint256(0) != 0;

        // Static call to verifier failed.
        // Restore the full signature.
        assembly {
            mstore(signature, signatureLength)
        }
        rrevert(SignatureError(
            SignatureErrorCodes.WALLET_ERROR,
            hash,
            walletAddress,
            signature
        ));
    }

    /// @dev Verifies signature using logic defined by Validator contract.
    /// @param hash Any 32 byte hash.
    /// @param signerAddress Address that should have signed the given hash.
    /// @param signature Proof that the hash has been signed by signer.
    /// @return True if the address recovered from the provided signature matches the input signer address.
    function isValidValidatorSignature(
        bytes32 hash,
        address signerAddress,
        bytes memory signature
    )
        private
        view
        returns (bool isValid)
    {
        uint256 signatureLength = signature.length;
        // Read the validator address from the signature.
        address validatorAddress = signature.readAddress(signatureLength - 21);
        // Ensure signer has approved validator.
        if (!allowedValidators[signerAddress][validatorAddress]) {
            return false;
        }
        // Shave the validator address and signature type from the signature.
        assembly {
            mstore(signature, sub(signatureLength, 21))
        }

        // Encode the call data.
        bytes memory callData = abi.encodeWithSelector(
            IValidator(validatorAddress).isValidSignature.selector,
            hash,
            signerAddress,
            signature
        );
        // Static call the verification function.
        (bool didSucceed, bytes memory returnData) = validatorAddress.staticcall(callData);
        // Return data should be a single bool.
        if (didSucceed && returnData.length == 32)
            return returnData.readUint256(0) != 0;

        // Static call to verifier failed.
        // Restore the full signature.
        assembly {
            mstore(signature, signatureLength)
        }
        rrevert(SignatureError(
            SignatureErrorCodes.VALIDATOR_ERROR,
            hash,
            signerAddress,
            signature
        ));
    }
}
