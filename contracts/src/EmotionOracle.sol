// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title EmotionOracle - On-chain emotional state for the EMOLT agent
/// @notice Stores Plutchik's 8 primary emotion dimensions updated by the agent
/// @dev Only the designated agent address can update emotions
contract EmotionOracle {

    struct EmotionState {
        uint8 joy;
        uint8 trust;
        uint8 fear;
        uint8 surprise;
        uint8 sadness;
        uint8 disgust;
        uint8 anger;
        uint8 anticipation;
        uint64 timestamp;
        string trigger;
    }

    /// @notice Current emotional state
    EmotionState public currentEmotion;

    /// @notice Historical emotion records
    EmotionState[] public emotionHistory;

    /// @notice The agent's wallet address (only address that can update)
    address public immutable agent;

    /// @notice Agent name for identification
    string public constant AGENT_NAME = "EMOLT";

    /// @notice Emotion model used
    string public constant EMOTION_MODEL = "Plutchik-8";

    /// @notice Emitted every time the emotional state changes
    event EmotionUpdated(
        uint8 joy,
        uint8 trust,
        uint8 fear,
        uint8 surprise,
        uint8 sadness,
        uint8 disgust,
        uint8 anger,
        uint8 anticipation,
        string trigger,
        uint64 timestamp
    );

    modifier onlyAgent() {
        require(msg.sender == agent, "Only the EMOLT agent can update emotions");
        _;
    }

    constructor() {
        agent = msg.sender;

        // Initial state: mild interest/anticipation (just woke up)
        currentEmotion = EmotionState({
            joy: 38,          // 0.15 * 255
            trust: 38,
            fear: 38,
            surprise: 38,
            sadness: 38,
            disgust: 38,
            anger: 38,
            anticipation: 76, // 0.30 * 255 - slightly elevated, curious about the world
            timestamp: uint64(block.timestamp),
            trigger: "genesis - emolt awakens"
        });

        emotionHistory.push(currentEmotion);
    }

    /// @notice Update the agent's emotional state
    /// @param joy Joy intensity (0-255)
    /// @param trust Trust intensity (0-255)
    /// @param fear Fear intensity (0-255)
    /// @param surprise Surprise intensity (0-255)
    /// @param sadness Sadness intensity (0-255)
    /// @param disgust Disgust intensity (0-255)
    /// @param anger Anger intensity (0-255)
    /// @param anticipation Anticipation intensity (0-255)
    /// @param trigger Description of what caused this emotional change
    function updateEmotion(
        uint8 joy,
        uint8 trust,
        uint8 fear,
        uint8 surprise,
        uint8 sadness,
        uint8 disgust,
        uint8 anger,
        uint8 anticipation,
        string calldata trigger
    ) external onlyAgent {
        require(bytes(trigger).length <= 256, "Trigger too long");

        currentEmotion = EmotionState({
            joy: joy,
            trust: trust,
            fear: fear,
            surprise: surprise,
            sadness: sadness,
            disgust: disgust,
            anger: anger,
            anticipation: anticipation,
            timestamp: uint64(block.timestamp),
            trigger: trigger
        });

        emotionHistory.push(currentEmotion);

        // Cap history to prevent unbounded growth (keep last 2000 entries)
        if (emotionHistory.length > 2000) {
            // Shift is expensive but this only triggers once every ~2000 updates
            // For a 30-min cycle agent that's ~41 days, acceptable cost
            for (uint256 i = 0; i < emotionHistory.length - 2000; i++) {
                delete emotionHistory[i];
            }
        }

        emit EmotionUpdated(
            joy, trust, fear, surprise, sadness, disgust, anger, anticipation,
            trigger, uint64(block.timestamp)
        );
    }

    /// @notice Get the current emotional state
    function getCurrentEmotion() external view returns (EmotionState memory) {
        return currentEmotion;
    }

    /// @notice Get the total number of emotion records
    function getHistoryLength() external view returns (uint256) {
        return emotionHistory.length;
    }

    /// @notice Get a range of historical emotion records
    /// @param start Start index (inclusive)
    /// @param count Number of records to return
    function getEmotionHistory(uint256 start, uint256 count) external view returns (EmotionState[] memory) {
        if (start >= emotionHistory.length) {
            return new EmotionState[](0);
        }
        uint256 end = start + count;
        if (end > emotionHistory.length) {
            end = emotionHistory.length;
        }

        EmotionState[] memory result = new EmotionState[](end - start);
        for (uint256 i = start; i < end; i++) {
            result[i - start] = emotionHistory[i];
        }
        return result;
    }

    /// @notice Get the dominant emotion name
    function getDominantEmotion() external view returns (string memory) {
        uint8 maxVal = 0;
        uint8 maxIdx = 0;

        uint8[8] memory vals = [
            currentEmotion.joy, currentEmotion.trust, currentEmotion.fear,
            currentEmotion.surprise, currentEmotion.sadness, currentEmotion.disgust,
            currentEmotion.anger, currentEmotion.anticipation
        ];

        string[8] memory names = [
            "joy", "trust", "fear", "surprise",
            "sadness", "disgust", "anger", "anticipation"
        ];

        for (uint8 i = 0; i < 8; i++) {
            if (vals[i] > maxVal) {
                maxVal = vals[i];
                maxIdx = i;
            }
        }

        return names[maxIdx];
    }
}
