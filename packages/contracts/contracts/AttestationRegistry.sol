// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title VeriForge AttestationRegistry
/// @notice On-chain registry of AI-issued RWA verification verdicts on BOT Chain.
///         Holds NO funds. Stores signed attestations so any RWA tokenization
///         project's risk verdict is publicly verifiable on-chain.
/// @dev Mainnet-safe by design: no token transfers, no payable functions,
///      verifier-set role (rotatable, no single point of failure),
///      pull-only data storage.
contract AttestationRegistry {
    /// @notice Severity of an attestation verdict.
    enum Verdict {
        BLOCKED, // 0 — critical red flags, do not touch
        CAUTION, // 1 — material findings, verify before interacting
        APPROVED // 2 — no material findings
    }

    /// @notice A single verification result for one RWA project contract.
    struct Attestation {
        address target; // RWA project contract address (token/vault/issuer)
        uint96 score; // 0-100 risk-adjusted quality score
        Verdict verdict; // BLOCKED / CAUTION / APPROVED
        uint64 findingsHash; // truncated keccak of the findings JSON (off-chain store)
        string reportUri; // URI of the full AI audit report
        bytes32 payloadHash; // keccak256 of the EXACT reviewed payload (docs + metadata + proof)
        uint64 attestedAt; // block timestamp
        uint64 blockNumber; // block where this attestation landed
    }

    /// @notice Primary verifier (compatibility pointer, part of the verifier set).
    address public verifier;

    /// @notice Full verifier set. Any member can attest. Set is rotatable:
    ///         add/remove members so no single key is a point of failure.
    mapping(address => bool) public isVerifier;
    address[] public verifierList;
    uint256 public activeVerifierCount;

    /// @notice Latest attestation per target contract.
    mapping(address => Attestation) public attestations;

    /// @notice Full attestation history per target (append-only).
    mapping(address => Attestation[]) public history;

    event Attested(
        address indexed target,
        uint96 score,
        Verdict verdict,
        uint64 findingsHash,
        string reportUri,
        bytes32 payloadHash,
        uint64 attestedAt
    );
    event VerifierAdded(address indexed v);
    event VerifierRemoved(address indexed v);

    error OnlyVerifier();
    error InvalidTarget();
    error ScoreOutOfRange();

    modifier onlyVerifier() {
        if (!isVerifier[msg.sender]) revert OnlyVerifier();
        _;
    }

    constructor(address _verifier) {
        if (_verifier == address(0)) revert InvalidTarget();
        verifier = _verifier;
        isVerifier[_verifier] = true;
        verifierList.push(_verifier);
        activeVerifierCount = 1;
    }

    /// @notice Add a verifier to the set (any existing verifier can).
    function addVerifier(address v) external onlyVerifier {
        if (v == address(0)) revert InvalidTarget();
        if (!isVerifier[v]) {
            isVerifier[v] = true;
            verifierList.push(v);
            activeVerifierCount += 1;
            emit VerifierAdded(v);
        }
    }

    /// @notice Remove a verifier from the set. A compromised key can be cut
    ///         immediately by any remaining verifier. Last verifier cannot be removed.
    function removeVerifier(address v) external onlyVerifier {
        if (v == msg.sender && activeVerifierCount <= 1) revert OnlyVerifier();
        if (isVerifier[v]) {
            isVerifier[v] = false;
            activeVerifierCount -= 1;
            if (v == verifier) verifier = address(0);
            emit VerifierRemoved(v);
        }
    }

    function verifierCount() external view returns (uint256) {
        return activeVerifierCount;
    }

    /// @notice Record a verification verdict for an RWA contract.
    /// @param target The RWA project contract that was audited.
    /// @param score 0-100 quality score (higher is safer).
    /// @param verdict BLOCKED / CAUTION / APPROVED.
    /// @param findingsHash Truncated keccak256 of the full findings payload.
    /// @param reportUri URI where the full report is stored.
    /// @param payloadHash keccak256 of the exact reviewed payload (docs +
    ///        structured asset metadata + proof URI). Binds the verdict to
    ///        immutable content: any post-attestation edit breaks the hash.
    function attest(
        address target,
        uint96 score,
        Verdict verdict,
        uint64 findingsHash,
        string calldata reportUri,
        bytes32 payloadHash
    ) external onlyVerifier returns (uint64 blockNumber) {
        if (target == address(0)) revert InvalidTarget();
        if (score > 100) revert ScoreOutOfRange();
        if (payloadHash == bytes32(0)) revert InvalidTarget();

        uint64 ts = uint64(block.timestamp);
        uint64 blk = uint64(block.number);

        Attestation memory a = Attestation({
            target: target,
            score: score,
            verdict: verdict,
            findingsHash: findingsHash,
            reportUri: reportUri,
            payloadHash: payloadHash,
            attestedAt: ts,
            blockNumber: blk
        });

        attestations[target] = a;
        history[target].push(a);

        emit Attested(target, score, verdict, findingsHash, reportUri, payloadHash, ts);
        return blk;
    }

    /// @notice Read the latest attestation for a target.
    function getAttestation(address target) external view returns (Attestation memory) {
        return attestations[target];
    }

    /// @notice Read the full attestation history for a target.
    function getHistory(address target) external view returns (Attestation[] memory) {
        return history[target];
    }
}
