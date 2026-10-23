// Compensating writes for standalone MongoDB. This is best effort: process crashes
// and concurrent changes cannot be made atomic without database transactions.
async function withRollback(work, logger = console) {
  const undo = [];
  const step = async (write, compensate) => {
    const result = await write();
    if (compensate && result !== null && result?.matchedCount !== 0) undo.push(compensate);
    return result;
  };
  try {
    return await work(step);
  } catch (error) {
    const failures = [];
    for (const compensate of undo.reverse()) {
      try {
        const result = await compensate();
        if (result?.matchedCount === 0 || result?.deletedCount === 0) {
          throw new Error('Rollback yozuvi topilmadi.');
        }
      }
      catch (rollbackError) {
        failures.push(rollbackError);
        logger.error('Rollback xatoligi:', rollbackError);
      }
    }
    if (failures.length) throw new AggregateError([error, ...failures], 'Rollback to‘liq bajarilmadi.');
    throw error;
  }
}

module.exports = { withRollback };
