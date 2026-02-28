
// Test script for GithubFirmware.ts logic (Simulator)

const GITHUB_OWNER = 'danstonedev';
const GITHUB_REPO = 'connect2imu';

async function test() {
    console.log('Testing fetchLatestRelease logic...');

    // 1. Try latest
    console.log('1. Fetching latest...');
    let response = await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`);
    console.log('Latest Status:', response.status);

    if (!response.ok && response.status === 404) {
        console.log('   -> 404 caught. Fetching all releases...');
        response = await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases`);
        console.log('   All Releases Status:', response.status);
        const all = await response.json();
        if (all.length > 0) {
            const r = all[0];
            console.log('   First Release found: Tag=', r.tag_name, 'Name=', r.name);

            // Logic check
            let v = parseVersion(r.tag_name);
            console.log('   Parsed Tag Version:', v);

            if (v.major === 0 && v.minor === 0 && v.patch === 0 && r.name) {
                console.log('   -> Tag failed. Parsing Name:', r.name);
                v = parseVersion(r.name);
                console.log('   Parsed Name Version:', v);
            }

            if (v.major === 1 && v.minor === 0 && v.patch === 1) {
                console.log('SUCCESS: Version resolved to 1.0.1');
            } else {
                console.error('FAILURE: Could not resolve to 1.0.1');
            }
        }
    } else {
        console.log('Latest found directly (Unexpected given 404 reports)');
    }
}

function parseVersion(version) {
    const match = (version || '').replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)/);
    if (!match) return { major: 0, minor: 0, patch: 0 };
    return {
        major: parseInt(match[1], 10),
        minor: parseInt(match[2], 10),
        patch: parseInt(match[3], 10)
    };
}

test();
