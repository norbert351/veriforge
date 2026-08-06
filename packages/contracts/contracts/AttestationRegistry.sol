// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title VeriForge AttestationRegistry
/// @notice On-chain registry of AI-issued RWA verification verdicts on BOT Chain.
///         Holds NO funds. Stores signed attestations so any RWA tokenization
///         project's risk verdict is publicly verifiable on-chain.
/// @dev Mainnet-safe by design: no token transfers, no payable functions,
///      single verifier role, pull-only data storage.
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
        uint64 attestedAt; // block timestamp
        uint64 blockNumber; // block where this attestation landed
    }

    /// @notice Verifier role. Only the VeriForge AI backend signs attestations.
    address public verifier;

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
        uint64 attestedAt
    );

    event VerifierChanged(address indexed oldVerifier, address indexed newVerifier);

    error OnlyVerifier();
    error InvalidTarget();
    error ScoreOutOfRange();

    modifier onlyVerifier() {
        if (msg.sender != verifier) revert OnlyVerifier();
        _;
    }

    constructor(address _verifier) {
        verifier = _verifier;
    }

    /// @notice Record a verification verdict for an RWA contract.
    /// @param target The RWA project contract that was audited.
    /// @param score 0-100 quality score (higher is safer).
    /// @param verdict BLOCKED / CAUTION / APPROVED.
    /// @param findingsHash Truncated keccak256 of the full findings payload.
    /// @param reportUri URI where the full report is stored.
    function attest(
        address target,
        uint96 score,
        Verdict verdict,
        uint64 findingsHash,
        string calldata reportUri
    ) external onlyVerifier returns (uint64 blockNumber) {
        if (target == address(0)) revert InvalidTarget();
        if (score > 100) revert ScoreOutOfRange();

        uint64 ts = uint64(block.timestamp);
        uint64 blk = uint64(block.number);

        Attestation memory a = Attestation({
            target: target,
            score: score,
            verdict: verdict,
            findingsHash: findingsHash,
            reportUri: reportUri,
            attestedAt: ts,
            blockNumber: blk
        });

        attestations[target] = a;
        history[target].push(a);

        emit Attested(target, score, verdict, findingsHash, reportUri, ts);
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

    /// @notice Transfer the verifier role (owner of current verifier only).
    function setVerifier(address newVerifier) external onlyVerifier {
        emit VerifierChanged(verifier, newVerifier);
        verifier = newVerifier;
    }
}
