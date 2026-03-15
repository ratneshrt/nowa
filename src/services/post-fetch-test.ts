import "dotenv/config";
import {
  getAllPosts,
  getAllEdits,
  getPostTotals,
  shutdownDatabasePool,
} from "../db/db-ops";

async function main(): Promise<void> {
  try {
    const posts = await getAllPosts();
    console.log(`Fetched ${posts.length} posts.`);

    const totals = await getPostTotals();
    console.log("Post totals:", totals);

    const [msgIdArg] = process.argv.slice(2);
    if (msgIdArg) {
      const msgId = Number(msgIdArg);
      if (Number.isNaN(msgId)) {
        console.warn(
          `Skipping edits fetch because "${msgIdArg}" is not a valid number.`
        );
      } else {
        const edits = await getAllEdits(msgId);
        console.log(`Fetched ${edits.length} edits for message ${msgId}.`);
        console.log("Edits:", edits);
      }
    } else {
      console.log("No message id provided, skipping edits fetch.");
    }
  } finally {
    await shutdownDatabasePool();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error("Failed to run post fetch test:", error);
    process.exitCode = 1;
  });
}
