import { requestAccountDeletion } from "./account-deletion-api";
import {
  preparePendingAccountDeletion,
  saveDeletionReceiptId,
} from "./deletion-storage";

/** The ordering is the recovery guarantee: encrypted local capability first,
 * network second, optional receipt decoration last. */
export async function beginAccountDeletion(
  userId: string,
  environmentUrl: string,
) {
  const pending = await preparePendingAccountDeletion(userId, environmentUrl);
  const result = await requestAccountDeletion(pending);
  await saveDeletionReceiptId(pending, result.receipt_id);
  return result;
}
