// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AttestationRegistry} from "./AttestationRegistry.sol";

/// @title IssuanceRegistry
/// @notice On-chain catalog of tokenized RWA issuances on BOT Chain.
///         The AI compliance gate is enforced HERE: an issuance can only be
///         listed if its RwaToken carries an APPROVED attestation from the
///         verifier set (the VeriForge AI backend). Refuses unapproved issuances.
///         Holds no funds. Only the verifier can list.
contract IssuanceRegistry {
    /// @notice A listed issuance.
    struct Issuance {
        uint64 id;
        address issuer; // who deploys + sells units
        address token; // RwaToken (units)
        address distributor; // RevenueDistributor (revenue share pool)
        uint256 pricePerToken; // USDT 6dp per 1e18 unit
        string docsUri; // issuer documentation reviewed by the AI gate
        bytes32 payloadHash; // commitment to the exact reviewed payload (docs + metadata + proof)
        uint64 listedAt;
        uint64 blockNumber;
    }

    AttestationRegistry public immutable attestations;
    address public verifier;

    Issuance[] private _issuances;
    mapping(address => uint64) private _tokenToId; // token -> id+1 (0 = not listed)

    event Issued(
        uint64 indexed id,
        address indexed issuer,
        address indexed token,
        address distributor,
        uint256 pricePerToken,
        string docsUri,
        bytes32 payloadHash
    );
    event VerifierChanged(address indexed oldVerifier, address indexed newVerifier);

    error OnlyVerifier();
    error NotApproved();
    error AlreadyListed();
    error ZeroAddress();
    error InvalidPrice();
    error InvalidPayload();

    modifier onlyVerifier() {
        if (msg.sender != verifier) revert OnlyVerifier();
        _;
    }

    constructor(address verifier_, address attestations_) {
        if (verifier_ == address(0) || attestations_ == address(0)) revert ZeroAddress();
        verifier = verifier_;
        attestations = AttestationRegistry(attestations_);
    }

    /// @notice List a new issuance. Reverts unless the token carries an
    ///         APPROVED attestation — the on-chain enforcement of the AI gate.
    /// @param issuer_ Owner selling units.
    /// @param token RwaToken address.
    /// @param distributor RevenueDistributor address.
    /// @param pricePerToken USDT 6dp per 1e18 unit.
    /// @param docsUri Documentation reviewed by the AI compliance gate.
    /// @param payloadHash Commitment to the exact reviewed payload. Must match
    ///        the hash the verifier attested, or the listing is refused.
    function issue(
        address issuer_,
        address token,
        address distributor,
        uint256 pricePerToken,
        string calldata docsUri,
        bytes32 payloadHash
    ) external onlyVerifier returns (uint64 id) {
        if (issuer_ == address(0) || token == address(0) || distributor == address(0)) revert ZeroAddress();
        if (pricePerToken == 0) revert InvalidPrice();
        if (_tokenToId[token] != 0) revert AlreadyListed();

        // ── THE AI GATE, enforced on-chain ──────────────────────────────
        // AttestationRegistry only lets verifier-set members write, and only
        // stores verdicts the AI backend produced. No APPROVED attestation
        // with a matching payload commitment => no listing.
        AttestationRegistry.Attestation memory a = attestations.getAttestation(token);
        if (a.verdict != AttestationRegistry.Verdict.APPROVED) revert NotApproved();
        if (a.payloadHash != payloadHash) revert InvalidPayload();

        id = uint64(_issuances.length) + 1;
        _issuances.push(Issuance({
            id: id,
            issuer: issuer_,
            token: token,
            distributor: distributor,
            pricePerToken: pricePerToken,
            docsUri: docsUri,
            payloadHash: payloadHash,
            listedAt: uint64(block.timestamp),
            blockNumber: uint64(block.number)
        }));
        _tokenToId[token] = id;

        emit Issued(id, issuer_, token, distributor, pricePerToken, docsUri, payloadHash);
    }

    function setVerifier(address newVerifier) external onlyVerifier {
        if (newVerifier == address(0)) revert ZeroAddress();
        emit VerifierChanged(verifier, newVerifier);
        verifier = newVerifier;
    }

    function count() external view returns (uint64) {
        return uint64(_issuances.length);
    }

    function getIssuance(uint64 id) external view returns (Issuance memory) {
        return _issuances[id - 1];
    }

    function getIssuanceByToken(address token) external view returns (Issuance memory) {
        uint64 id = _tokenToId[token];
        if (id == 0) revert ZeroAddress();
        return _issuances[id - 1];
    }

    function getAll() external view returns (Issuance[] memory) {
        return _issuances;
    }
}
