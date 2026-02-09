// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "solady/tokens/ERC721.sol";
import "solady/utils/LibString.sol";
import "solady/utils/Base64.sol";

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

interface IEmotionOracle {
    function getCurrentEmotion() external view returns (EmotionState memory);
}

/// @title EmoodRing - Soulbound dynamic SVG NFT showing EMOLT's emotional state
/// @notice Reads from EmotionOracle and renders a Plutchik wheel visualization on-chain
/// @dev ERC-721 + ERC-5192 (soulbound) + ERC-4906 (metadata update)
contract EmoodRing is ERC721 {
    using LibString for uint256;
    using LibString for int256;

    // ─── ERC-5192 Soulbound ─────────────────────────────────────

    event Locked(uint256 tokenId);

    // ─── ERC-4906 Metadata Update ───────────────────────────────

    event MetadataUpdate(uint256 _tokenId);
    event BatchMetadataUpdate(uint256 _fromTokenId, uint256 _toTokenId);

    // ─── State ──────────────────────────────────────────────────

    address public immutable oracle;
    address public immutable agent;

    // ─── Trig lookup (scaled by 1000) ───────────────────────────
    // Angles: 0, 45, 90, 135, 180, 225, 270, 315 degrees
    // cos values * 1000
    int16[8] internal COS = [int16(1000), 707, 0, -707, -1000, -707, 0, 707];
    // sin values * 1000
    int16[8] internal SIN = [int16(0), 707, 1000, 707, 0, -707, -1000, -707];

    // Half-sector offsets (~21.4 degrees) cos/sin * 1000
    // cos(22.5°)=924, sin(22.5°)=383
    int16 internal constant COS_HALF = 924;
    int16 internal constant SIN_HALF = 383;

    // ─── Constructor ────────────────────────────────────────────

    constructor(address _oracle) {
        oracle = _oracle;
        agent = msg.sender;
        _mint(msg.sender, 0);
        emit Locked(0);
    }

    // ─── ERC-721 Metadata ───────────────────────────────────────

    function name() public pure override returns (string memory) {
        return "EmoodRing";
    }

    function symbol() public pure override returns (string memory) {
        return "MOOD";
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        require(tokenId == 0, "Only token 0 exists");
        EmotionState memory emo = IEmotionOracle(oracle).getCurrentEmotion();
        string memory svg = _generateSVG(emo);
        string memory json = string.concat(
            '{"name":"EmoodRing","description":"Soulbound dynamic NFT visualizing EMOLT\'s emotional state via Plutchik\'s wheel. Reads live from EmotionOracle on Monad.","image":"data:image/svg+xml;base64,',
            Base64.encode(bytes(svg)),
            '","attributes":[',
            _buildAttributes(emo),
            ']}'
        );
        return string.concat("data:application/json;base64,", Base64.encode(bytes(json)));
    }

    // ─── Soulbound: block transfers ─────────────────────────────

    function transferFrom(address, address, uint256) public payable override {
        revert("Soulbound: non-transferable");
    }

    function safeTransferFrom(address, address, uint256, bytes calldata) public payable override {
        revert("Soulbound: non-transferable");
    }

    function approve(address, uint256) public payable override {
        revert("Soulbound: approvals disabled");
    }

    function setApprovalForAll(address, bool) public pure override {
        revert("Soulbound: approvals disabled");
    }

    // ERC-5192
    function locked(uint256) external pure returns (bool) {
        return true;
    }

    // ERC-165
    function supportsInterface(bytes4 interfaceId) public pure override returns (bool) {
        return interfaceId == 0x01ffc9a7  // ERC-165
            || interfaceId == 0x80ac58cd  // ERC-721
            || interfaceId == 0x5b5e139f  // ERC-721Metadata
            || interfaceId == 0xb45a3c0e  // ERC-5192
            || interfaceId == 0x49064906; // ERC-4906
    }

    // Agent can signal metadata refresh
    function emitMetadataUpdate() external {
        require(msg.sender == agent, "Only agent");
        emit MetadataUpdate(0);
    }

    // ─── SVG Generation ─────────────────────────────────────────

    function _generateSVG(EmotionState memory emo) internal view returns (string memory) {
        // Find dominant
        uint8[8] memory vals = [emo.joy, emo.trust, emo.fear, emo.surprise, emo.sadness, emo.disgust, emo.anger, emo.anticipation];
        uint8 domIdx = 0;
        uint8 domVal = 0;
        for (uint8 i = 0; i < 8; i++) {
            if (vals[i] > domVal) { domVal = vals[i]; domIdx = i; }
        }

        // Build SVG parts
        string memory gradDefs = _buildGradients(vals);
        string memory sectors = _buildSectors(vals);
        string memory labels = _buildLabels(vals);
        string memory domColor = _getColor(domIdx);
        string memory domRGB = _getRGB(domIdx);
        string memory domLabel = _getTierLabel(domIdx, domVal);
        string memory compounds = _buildCompounds(vals);

        return string.concat(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 480" width="480" height="480"><defs>',
            gradDefs,
            '<radialGradient id="bg" cx="50%" cy="50%" r="72%"><stop offset="0%" stop-color="#101018"/><stop offset="100%" stop-color="#08080c"/></radialGradient>',
            '<radialGradient id="cGlow" cx="50%" cy="50%" r="50%"><stop offset="0%" stop-color="rgb(',domRGB,')" stop-opacity="0.06"/><stop offset="100%" stop-color="rgb(',domRGB,')" stop-opacity="0"/></radialGradient></defs>',
            '<rect width="480" height="480" fill="url(#bg)" rx="20"/>',
            '<circle cx="240" cy="240" r="90" fill="url(#cGlow)"/>',
            '<circle cx="240" cy="240" r="160" fill="none" stroke="#fff" stroke-width="0.3" opacity="0.045" stroke-dasharray="1,3"/>',
            sectors, labels,
            '<circle cx="240" cy="240" r="30" fill="#0b0b13"/>',
            '<circle cx="240" cy="240" r="30" fill="none" stroke="#fff" stroke-width="0.4" opacity="0.07"/>',
            '<circle cx="240" cy="240" r="3.5" fill="',domColor,'" opacity="0.75"/>',
            '<text x="240" y="22" text-anchor="middle" fill="#fff" opacity="0.14" font-family="sans-serif" font-size="9" font-weight="500" letter-spacing="5">EMOLT</text>',
            '<text x="240" y="467" text-anchor="middle" fill="',domColor,'" opacity="0.65" font-family="sans-serif" font-size="10" font-weight="500" letter-spacing="3">',domLabel,'</text>',
            compounds,
            '</svg>'
        );
    }

    // ─── Gradients ──────────────────────────────────────────────

    function _buildGradients(uint8[8] memory /* vals */) internal view returns (string memory result) {
        for (uint8 i = 0; i < 8; i++) {
            // Gradient focal point along the emotion's angle
            int256 gx = 50 + (int256(COS[i]) * 45) / 1000;
            int256 gy = 50 + (int256(SIN[i]) * 45) / 1000;
            string memory dimC = _dimColor(i, 18);
            string memory midC = _dimColor(i, 50);
            string memory fullC = _getColor(i);
            result = string.concat(
                result,
                '<radialGradient id="sg',LibString.toString(uint256(i)),'" cx="50%" cy="50%" r="60%" fx="',
                LibString.toString(uint256(int256(gx))),'%" fy="',LibString.toString(uint256(int256(gy))),'%">',
                '<stop offset="0%" stop-color="',dimC,'"/>',
                '<stop offset="40%" stop-color="',midC,'"/>',
                '<stop offset="100%" stop-color="',fullC,'"/></radialGradient>'
            );
        }
    }

    // ─── Sectors ────────────────────────────────────────────────

    function _buildSectors(uint8[8] memory vals) internal view returns (string memory result) {
        for (uint8 i = 0; i < 8; i++) {
            uint256 norm1000 = (uint256(vals[i]) * 1000) / 255; // 0-1000
            uint256 outerR = 44 + ((160 - 44) * norm1000) / 1000;
            uint256 opacity1000 = 600 + (norm1000 * 400) / 1000;
            string memory path = _sectorPath(240, 240, 30, outerR, i);
            result = string.concat(
                result,
                '<path d="',path,'" fill="url(#sg',LibString.toString(uint256(i)),')" opacity="0.',_pad3(opacity1000),'"/>'
            );
        }
    }

    // ─── Sector Path ────────────────────────────────────────────

    function _sectorPath(uint256 cx, uint256 cy, uint256 innerR, uint256 outerR, uint8 idx) internal view returns (string memory) {
        // Start angle = emotion angle - half sector
        // End angle = emotion angle + half sector
        // Using rotation: start = rotate(angle, -22.5°), end = rotate(angle, +22.5°)

        int256 cA = int256(COS[idx]); // cos(angle)
        int256 sA = int256(SIN[idx]); // sin(angle)

        // cos(angle - 22.5) = cos(a)*cos(22.5) + sin(a)*sin(22.5)
        int256 cs1 = (cA * COS_HALF + sA * SIN_HALF) / 1000;
        int256 ss1 = (sA * COS_HALF - cA * SIN_HALF) / 1000;

        // cos(angle + 22.5) = cos(a)*cos(22.5) - sin(a)*sin(22.5)
        int256 cs2 = (cA * COS_HALF - sA * SIN_HALF) / 1000;
        int256 ss2 = (sA * COS_HALF + cA * SIN_HALF) / 1000;

        int256 icx = int256(cx);
        int256 icy = int256(cy);

        // Inner start, outer start, outer end, inner end
        int256 ix1 = icx + (cs1 * int256(innerR)) / 1000;
        int256 iy1 = icy + (ss1 * int256(innerR)) / 1000;
        int256 ox1 = icx + (cs1 * int256(outerR)) / 1000;
        int256 oy1 = icy + (ss1 * int256(outerR)) / 1000;
        int256 ox2 = icx + (cs2 * int256(outerR)) / 1000;
        int256 oy2 = icy + (ss2 * int256(outerR)) / 1000;
        int256 ix2 = icx + (cs2 * int256(innerR)) / 1000;
        int256 iy2 = icy + (ss2 * int256(innerR)) / 1000;

        // Bulge control point at mid angle, 110% outerR
        int256 bulgeR = (int256(outerR) * 1100) / 1000;
        int256 bcx = icx + (cA * bulgeR) / 1000;
        int256 bcy = icy + (sA * bulgeR) / 1000;

        return string.concat(
            "M", _coord(ix1), ",", _coord(iy1),
            " L", _coord(ox1), ",", _coord(oy1),
            " Q", _coord(bcx), ",", _coord(bcy), " ", _coord(ox2), ",", _coord(oy2),
            " L", _coord(ix2), ",", _coord(iy2),
            " A", LibString.toString(innerR), ",", LibString.toString(innerR), " 0 0,0 ", _coord(ix1), ",", _coord(iy1), "Z"
        );
    }

    // ─── Labels ─────────────────────────────────────────────────

    function _buildLabels(uint8[8] memory vals) internal view returns (string memory result) {
        uint256 labelR = 188; // maxOuterR(160) + 28
        for (uint8 i = 0; i < 8; i++) {
            uint256 norm1000 = (uint256(vals[i]) * 1000) / 255;
            int256 lx = 240 + (int256(COS[i]) * int256(labelR)) / 1000;
            int256 ly = 240 + (int256(SIN[i]) * int256(labelR)) / 1000;
            string memory tierLabel = _getTierLabel(i, vals[i]);
            string memory color = _getColor(i);
            uint256 pct = (uint256(vals[i]) * 100) / 255;
            uint256 labelOp = 600 + (norm1000 * 400) / 1000;
            uint256 pctOp = 350 + (norm1000 * 500) / 1000;
            uint256 pillOp = 80 + (norm1000 * 150) / 1000;
            uint256 fontSize = norm1000 > 660 ? 11 : (norm1000 > 330 ? 10 : 9);

            // Dark base pill + color tint pill
            result = string.concat(
                result,
                '<rect x="',_coord(lx - 40),'" y="',_coord(ly - 12),'" width="80" height="28" rx="10" fill="#000" opacity="0.350"/>',
                '<rect x="',_coord(lx - 40),'" y="',_coord(ly - 12),'" width="80" height="28" rx="10" fill="',color,'" opacity="0.',_pad3(pillOp),'"/>'
            );
            // Tier label
            result = string.concat(
                result,
                '<text x="',_coord(lx),'" y="',_coord(ly - 1),'" text-anchor="middle" dominant-baseline="middle" fill="',color,'" opacity="0.',_pad3(labelOp),'" font-family="sans-serif" font-size="',LibString.toString(fontSize),'" font-weight="600" letter-spacing="1">',tierLabel,'</text>'
            );
            // Percentage
            result = string.concat(
                result,
                '<text x="',_coord(lx),'" y="',_coord(ly + 11),'" text-anchor="middle" dominant-baseline="middle" fill="',color,'" opacity="0.',_pad3(pctOp),'" font-family="monospace" font-size="8" font-weight="500">',LibString.toString(pct),'%</text>'
            );
        }
    }

    // ─── Compounds ──────────────────────────────────────────────

    function _buildCompounds(uint8[8] memory vals) internal pure returns (string memory) {
        // joy=0, trust=1, fear=2, surprise=3, sadness=4, disgust=5, anger=6, anticipation=7
        uint8 th = 76;
        string[12] memory names = ["love","submission","awe","disapproval","remorse","contempt","aggressiveness","optimism","anxiety","pride","despair","curiosity"];
        uint8[2][12] memory pairs = [
            [0,1],[1,2],[2,3],[3,4],[4,5],[5,6],[6,7],[7,0],
            [7,2],[6,0],[2,4],[1,3]
        ];

        string memory found;
        uint8 count = 0;
        for (uint8 i = 0; i < 12 && count < 3; i++) {
            if (vals[pairs[i][0]] >= th && vals[pairs[i][1]] >= th) {
                if (count > 0) found = string.concat(found, "  /  ");
                found = string.concat(found, names[i]);
                count++;
            }
        }

        if (count == 0) return "";
        return string.concat(
            '<text x="240" y="452" text-anchor="middle" fill="#555" font-family="sans-serif" font-size="8.5" font-weight="300" letter-spacing="2.5">',
            found, '</text>'
        );
    }

    // ─── Attributes for JSON metadata ───────────────────────────

    function _buildAttributes(EmotionState memory emo) internal view returns (string memory) {
        uint8[8] memory vals = [emo.joy, emo.trust, emo.fear, emo.surprise, emo.sadness, emo.disgust, emo.anger, emo.anticipation];
        string[8] memory emotionNames = ["Joy","Trust","Fear","Surprise","Sadness","Disgust","Anger","Anticipation"];

        uint8 domIdx = 0; uint8 domVal = 0;
        for (uint8 i = 0; i < 8; i++) { if (vals[i] > domVal) { domVal = vals[i]; domIdx = i; } }

        string memory result;
        for (uint8 i = 0; i < 8; i++) {
            uint256 pct = (uint256(vals[i]) * 100) / 255;
            if (i > 0) result = string.concat(result, ",");
            result = string.concat(result,
                '{"trait_type":"',emotionNames[i],'","value":',LibString.toString(pct),'}'
            );
        }
        result = string.concat(result,
            ',{"trait_type":"Dominant","value":"',_getTierLabel(domIdx, domVal),'"}'
        );
        return result;
    }

    // ─── Color helpers ──────────────────────────────────────────

    function _getColor(uint8 idx) internal pure returns (string memory) {
        if (idx == 0) return "#F5D831"; // joy
        if (idx == 1) return "#6ECB3C"; // trust
        if (idx == 2) return "#2BA84A"; // fear
        if (idx == 3) return "#22AACC"; // surprise
        if (idx == 4) return "#4A6BD4"; // sadness
        if (idx == 5) return "#A85EC0"; // disgust
        if (idx == 6) return "#E04848"; // anger
        return "#EF8E20"; // anticipation
    }

    function _getRGB(uint8 idx) internal pure returns (string memory) {
        if (idx == 0) return "245,216,49";
        if (idx == 1) return "110,203,60";
        if (idx == 2) return "43,168,74";
        if (idx == 3) return "34,170,204";
        if (idx == 4) return "74,107,212";
        if (idx == 5) return "168,94,192";
        if (idx == 6) return "224,72,72";
        return "239,142,32";
    }

    // Dimmed color for gradient stops: rgb(r*pct/100, g*pct/100, b*pct/100)
    function _dimColor(uint8 idx, uint256 pct) internal pure returns (string memory) {
        // Full RGB values
        uint256[3][8] memory rgbs = [
            [uint256(245),216,49], [uint256(110),203,60], [uint256(43),168,74], [uint256(34),170,204],
            [uint256(74),107,212], [uint256(168),94,192], [uint256(224),72,72], [uint256(239),142,32]
        ];
        uint256 r = (rgbs[idx][0] * pct) / 100;
        uint256 g = (rgbs[idx][1] * pct) / 100;
        uint256 b = (rgbs[idx][2] * pct) / 100;
        return string.concat("rgb(", LibString.toString(r), ",", LibString.toString(g), ",", LibString.toString(b), ")");
    }

    // ─── Tier labels ────────────────────────────────────────────

    function _getTierLabel(uint8 idx, uint8 val) internal pure returns (string memory) {
        // Low: 0-84, Mid: 85-170, High: 171-255
        string[3][8] memory tiers = [
            ["serenity","joy","ecstasy"],
            ["acceptance","trust","admiration"],
            ["apprehension","fear","terror"],
            ["distraction","surprise","amazement"],
            ["pensiveness","sadness","grief"],
            ["boredom","disgust","loathing"],
            ["annoyance","anger","rage"],
            ["interest","anticipation","vigilance"]
        ];
        if (val <= 84) return tiers[idx][0];
        if (val <= 170) return tiers[idx][1];
        return tiers[idx][2];
    }

    // ─── Coordinate helpers ─────────────────────────────────────

    function _coord(int256 v) internal pure returns (string memory) {
        if (v < 0) return string.concat("-", LibString.toString(uint256(-v)));
        return LibString.toString(uint256(v));
    }

    function _pad3(uint256 v) internal pure returns (string memory) {
        // Returns 3-digit string for opacity after "0." (e.g. 600 -> "600", 45 -> "045")
        if (v >= 1000) return "999";
        if (v >= 100) return LibString.toString(v);
        if (v >= 10) return string.concat("0", LibString.toString(v));
        return string.concat("00", LibString.toString(v));
    }
}
