const { ObjectId } = require('mongodb');

function publicNotification(row) {
  return {
    id: row._id.toString(),
    type: row.type,
    paymentId: row.paymentId.toString(),
    customerId: row.customerId.toString(),
    mijoz_id: row.mijoz_id,
    customerName: row.customerName,
    actorId: row.actorId.toString(),
    actorName: row.actorName,
    actorRole: row.actorRole,
    createdAt: row.createdAt,
    auditId: row.auditId.toString(),
    is_read: row.is_read,
    readAt: row.readAt,
  };
}

function registerPaymentEditNotificationRoutes(app, { authenticate, requireSuperAdmin, paymentEditNotifications, logger, now }) {
  app.get('/notifications/payment-edits', authenticate, requireSuperAdmin, async (req, res) => {
    const { page = '1', limit = '20', is_read } = req.query;
    if (Object.keys(req.query).some((key) => !['page', 'limit', 'is_read'].includes(key)) ||
        typeof page !== 'string' || typeof limit !== 'string' ||
        (is_read !== undefined && typeof is_read !== 'string') ||
        !/^[1-9]\d*$/.test(page) || !/^[1-9]\d*$/.test(limit) ||
        (is_read !== undefined && !['true', 'false'].includes(is_read)) ||
        !Number.isSafeInteger(Number(page)) || !Number.isSafeInteger(Number(limit)) ||
        Number(limit) > 100 || !Number.isSafeInteger((Number(page) - 1) * Number(limit))) {
      return res.status(400).json({ message: 'page, limit yoki is_read noto‘g‘ri.' });
    }
    try {
      const filter = is_read === undefined ? {} : { is_read: is_read === 'true' };
      const [total, unreadCount, rows] = await Promise.all([
        paymentEditNotifications.countDocuments(filter),
        paymentEditNotifications.countDocuments({ is_read: false }),
        paymentEditNotifications.find(filter).sort({ createdAt: -1, _id: -1 })
          .skip((Number(page) - 1) * Number(limit)).limit(Number(limit)).toArray(),
      ]);
      return res.json({ notifications: rows.map(publicNotification), total, unreadCount,
        page: Number(page), limit: Number(limit) });
    } catch (error) {
      logger.error('To‘lov tahriri notificationlarini olishda xatolik:', error);
      return res.status(500).json({ message: 'Serverda xatolik yuz berdi.' });
    }
  });

  app.patch('/notifications/payment-edits/read-all', authenticate, requireSuperAdmin, async (_req, res) => {
    try {
      const result = await paymentEditNotifications.updateMany({ is_read: false },
        { $set: { is_read: true, readAt: new Date(now()) } });
      return res.json({ markedCount: result.modifiedCount });
    } catch (error) {
      logger.error('Notificationlarni o‘qilgan qilishda xatolik:', error);
      return res.status(500).json({ message: 'Serverda xatolik yuz berdi.' });
    }
  });

  app.patch('/notifications/payment-edits/:id/read', authenticate, requireSuperAdmin, async (req, res) => {
    if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ message: 'Notification ID noto‘g‘ri.' });
    try {
      const id = new ObjectId(req.params.id);
      const notification = await paymentEditNotifications.findOneAndUpdate({ _id: id, is_read: false },
        { $set: { is_read: true, readAt: new Date(now()) } }, { returnDocument: 'after' }) ||
        await paymentEditNotifications.findOne({ _id: id });
      if (!notification) return res.status(404).json({ message: 'Notification topilmadi.' });
      return res.json({ notification: publicNotification(notification) });
    } catch (error) {
      logger.error('Notificationni o‘qilgan qilishda xatolik:', error);
      return res.status(500).json({ message: 'Serverda xatolik yuz berdi.' });
    }
  });
}

module.exports = { registerPaymentEditNotificationRoutes };
