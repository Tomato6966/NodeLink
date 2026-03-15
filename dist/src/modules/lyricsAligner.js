function similarity(s1, s2) {
    const longer = s1.length > s2.length ? s1 : s2;
    const shorter = s1.length > s2.length ? s2 : s1;
    const longerLength = longer.length;
    if (longerLength === 0)
        return 1.0;
    return ((longerLength - editDistance(longer, shorter)) / parseFloat(longerLength));
}
function editDistance(s1, s2) {
    s1 = s1.toLowerCase();
    s2 = s2.toLowerCase();
    const costs = [];
    for (let i = 0; i <= s1.length; i++) {
        let lastValue = i;
        for (let j = 0; j <= s2.length; j++) {
            if (i == 0)
                costs[j] = j;
            else {
                if (j > 0) {
                    let newValue = costs[j - 1];
                    if (s1.charAt(i - 1) != s2.charAt(j - 1))
                        newValue = Math.min(Math.min(newValue, lastValue), costs[j]) + 1;
                    costs[j - 1] = lastValue;
                    lastValue = newValue;
                }
            }
        }
        if (i > 0)
            costs[s2.length] = lastValue;
    }
    return costs[s2.length];
}
function cleanWord(text) {
    if (!text)
        return '';
    return text
        .replace(/\[.*?\]/g, '')
        .replace(/\(.*?\)/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');
}
function flattenYouTubeLyrics(ytLyrics) {
    const words = [];
    if (!ytLyrics?.lines)
        return words;
    for (const line of ytLyrics.lines) {
        if (line.text && /^\[.*\]$/.test(line.text.trim()))
            continue;
        if (line.words) {
            for (const w of line.words) {
                const clean = cleanWord(w.text);
                if (clean.length > 0) {
                    words.push({
                        text: clean,
                        time: parseInt(w.timestamp || w.time || 0)
                    });
                }
            }
        }
        else if (line.text) {
            const lineText = line.text.trim();
            const lineWords = lineText.split(/\s+/);
            const durationPerWord = (line.duration || 2000) / (lineWords.length || 1);
            lineWords.forEach((w, i) => {
                const clean = cleanWord(w);
                if (clean.length > 0) {
                    words.push({
                        text: clean,
                        time: parseInt(line.time) + i * durationPerWord
                    });
                }
            });
        }
    }
    return words;
}
function getLineWords(text) {
    if (!text)
        return [];
    return text
        .split(/\s+/)
        .map(cleanWord)
        .filter((w) => w.length > 0);
}
function findBestSequenceMatch(targetWords, ytWords, startIndex, searchWindowEnd) {
    if (targetWords.length === 0)
        return null;
    const keys = targetWords.slice(0, 5);
    if (keys.length === 0)
        return null;
    let bestMatch = null;
    let maxScore = 0;
    for (let i = startIndex; i < ytWords.length; i++) {
        const yw = ytWords[i];
        if (yw.time > searchWindowEnd)
            break;
        if (similarity(keys[0], yw.text) > 0.75) {
            let matchCount = 1;
            const checkLen = Math.min(keys.length, ytWords.length - i);
            let ytOffset = 0;
            for (let k = 1; k < checkLen; k++) {
                if (i + k + ytOffset < ytWords.length) {
                    if (similarity(keys[k], ytWords[i + k + ytOffset].text) > 0.75) {
                        matchCount++;
                    }
                    else if (i + k + ytOffset + 1 < ytWords.length &&
                        similarity(keys[k], ytWords[i + k + ytOffset + 1].text) > 0.75) {
                        matchCount++;
                        ytOffset++;
                    }
                }
            }
            const score = matchCount / keys.length;
            if (score > maxScore && score >= 0.7) {
                maxScore = score;
                bestMatch = { index: i, time: yw.time, score };
                if (score === 1.0)
                    break;
            }
        }
    }
    return bestMatch;
}
export function alignLyrics(hqLyrics, youtubeData) {
    if (!hqLyrics?.length || !youtubeData?.lines)
        return hqLyrics;
    const ytWords = flattenYouTubeLyrics(youtubeData);
    if (ytWords.length === 0)
        return hqLyrics;
    const alignedLines = [];
    let lastYtIndex = 0;
    let currentOffset = 0;
    let offsetInitialized = false;
    let pendingDeviation = null;
    const MAX_JUMP_MS = 2500;
    const SEARCH_LOOKAHEAD = 25000;
    for (let i = 0; i < hqLyrics.length; i++) {
        const line = hqLyrics[i];
        const words = getLineWords(line.text);
        const predictedYtTime = line.time + currentOffset;
        const match = findBestSequenceMatch(words, ytWords, lastYtIndex, predictedYtTime + SEARCH_LOOKAHEAD);
        let offsetToUse = currentOffset;
        if (match) {
            const instantOffset = match.time - line.time;
            if (!offsetInitialized) {
                currentOffset = instantOffset;
                offsetToUse = currentOffset;
                offsetInitialized = true;
            }
            else {
                const diff = Math.abs(instantOffset - currentOffset);
                if (diff > MAX_JUMP_MS) {
                    if (pendingDeviation) {
                        if (Math.abs(instantOffset - pendingDeviation.offset) < 1000) {
                            currentOffset = instantOffset;
                            offsetToUse = currentOffset;
                            pendingDeviation = null;
                        }
                        else {
                            pendingDeviation = { offset: instantOffset, index: i };
                            offsetToUse = currentOffset;
                        }
                    }
                    else {
                        pendingDeviation = { offset: instantOffset, index: i };
                        offsetToUse = currentOffset;
                    }
                }
                else {
                    pendingDeviation = null;
                    currentOffset = currentOffset * 0.8 + instantOffset * 0.2;
                    offsetToUse = currentOffset;
                }
            }
            if (match.index > lastYtIndex) {
                lastYtIndex = match.index;
            }
        }
        else {
            offsetToUse = currentOffset;
        }
        alignedLines.push({
            ...line,
            time: Math.max(0, Math.round(line.time + offsetToUse - 50))
        });
    }
    return alignedLines;
}
