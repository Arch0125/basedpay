import zkeSDK from "@zk-email/sdk";
import fs from "fs/promises";

// Copy slug from UI homepage
const blueprintSlug = "Arch0125/hdfcheader@v2";

export async function generateEmailProof(emldata: string) {
    const sdk = zkeSDK();

    // Get an instance of Blueprint
    const blueprint = await sdk.getBlueprint(blueprintSlug);

    // Create a prover from the blueprint
    const prover = blueprint.createProver();

    // Get eml
    const eml = (await fs.readFile("./hdfc.eml")).toString();

    // Generate and wait until proof is generated, can take up to a few minutes
    const proof = await prover.generateProof(eml);
    const { proofData, publicData } = proof.getProofData();
    console.log("proof: ", proofData);

    const requiredRegex = /(?<=Rs.)\d+/;
    const txAmountMatch = emldata.match(requiredRegex);
    return txAmountMatch;
}
