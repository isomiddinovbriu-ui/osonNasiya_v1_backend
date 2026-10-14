const { ObjectId } = require('mongodb');

const PAYMENT_METHODS = new Set(['cash', 'card', 'transfer']);
const CREATOR_ROLES = new Set(['super_admin', 'sotuvchi', 'yiguvchi']);

function publicPayment(payment) {
  return {
    id: payment._id.toString(),
    type: payment.type,
    amount: payment.amount,
    method: payment.method,
    receivedBy: payment.receivedBy.toString(),
    paidAt: payment.paidAt,
  };
}

function publicCustomer(customer) {
  return {
    id: customer._id.toString(),
    name: customer.name,
    phoneNumber: customer.phoneNumber,
    productName: customer.productName,
    regionId: customer.regionId.toString(),
    totalPrice: customer.totalPrice,
    downPayment: customer.downPayment,
    termMonths: customer.termMonths,
    totalPaid: customer.totalPaid,
    remainingBalance: customer.remainingBalance,
    description: customer.description,
    payments: customer.payments.map(publicPayment),
    createdBy: customer.createdBy.toString(),
    createdByRole: customer.createdByRole,
    createdAt: customer.createdAt,
  };
}

function validPhone(value) {
  return typeof value === 'string' && value.length <= 25 &&
    /^[+\d\s()-]+$/.test(value) &&
    value.replace(/\D/g, '').length >= 9 && value.replace(/\D/g, '').length <= 15;
}

function registerCustomerRoutes(app, { authenticate, customers, regions, logger, now }) {
  app.post('/customers', authenticate, async (req, res) => {
    if (!CREATOR_ROLES.has(res.locals.currentUser.role)) {
      return res.status(403).json({ message: 'Bu amal uchun ruxsat yo‘q.' });
    }

    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const phoneNumber = typeof req.body?.phoneNumber === 'string' ? req.body.phoneNumber.trim() : '';
    const productName = typeof req.body?.productName === 'string' ? req.body.productName.trim() : '';
    const description = req.body?.description === undefined ? '' : req.body.description;
    const { regionId, totalPrice, downPayment, termMonths, paymentMethod } = req.body || {};
    if (!name || name.length > 100 || !validPhone(phoneNumber) || !productName || productName.length > 100 ||
        !ObjectId.isValid(regionId) || !Number.isSafeInteger(totalPrice) || totalPrice <= 0 ||
        !Number.isSafeInteger(downPayment) || downPayment < 0 || downPayment > totalPrice ||
        !Number.isInteger(termMonths) || termMonths < 1 || termMonths > 120 ||
        (downPayment > 0 && !PAYMENT_METHODS.has(paymentMethod)) ||
        (downPayment === 0 && paymentMethod !== undefined && paymentMethod !== null) ||
        typeof description !== 'string' || description.length > 1000) {
      return res.status(400).json({ message: 'Mijoz, hudud, narx, muddat va boshlang‘ich to‘lov ma’lumotlarini to‘g‘ri kiriting.' });
    }

    try {
      const region = await regions.findOne({ _id: new ObjectId(regionId) });
      if (!region) return res.status(404).json({ message: 'Hudud topilmadi.' });

      const createdAt = new Date(now());
      const actor = res.locals.currentUser;
      const initialPayment = downPayment > 0 ? {
        _id: new ObjectId(),
        type: 'initial',
        amount: downPayment,
        method: paymentMethod,
        receivedBy: actor._id,
        paidAt: createdAt,
      } : null;
      const document = {
        name,
        phoneNumber,
        productName,
        regionId: region._id,
        totalPrice,
        downPayment,
        termMonths,
        totalPaid: downPayment,
        remainingBalance: totalPrice - downPayment,
        description: description.trim(),
        payments: initialPayment ? [initialPayment] : [],
        createdBy: actor._id,
        createdByRole: actor.role,
        createdAt,
      };
      const result = await customers.insertOne(document);
      return res.status(201).json({ customer: publicCustomer({ ...document, _id: result.insertedId }) });
    } catch (error) {
      logger.error('Mijoz yaratishda xatolik:', error);
      return res.status(500).json({ message: 'Serverda xatolik yuz berdi.' });
    }
  });

  app.get('/customers/:id', authenticate, async (req, res) => {
    if (!CREATOR_ROLES.has(res.locals.currentUser.role)) return res.status(403).json({ message: 'Bu amal uchun ruxsat yo‘q.' });
    if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ message: 'Mijoz ID noto‘g‘ri.' });
    try {
      const customer = await customers.findOne({ _id: new ObjectId(req.params.id) });
      if (!customer) return res.status(404).json({ message: 'Mijoz topilmadi.' });
      return res.json({ customer: publicCustomer(customer) });
    } catch (error) {
      logger.error('Mijozni olishda xatolik:', error);
      return res.status(500).json({ message: 'Serverda xatolik yuz berdi.' });
    }
  });

  app.post('/customers/:id/payments', authenticate, async (req, res) => {
    if (!CREATOR_ROLES.has(res.locals.currentUser.role)) return res.status(403).json({ message: 'Bu amal uchun ruxsat yo‘q.' });
    if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ message: 'Mijoz ID noto‘g‘ri.' });
    const { amount, method } = req.body || {};
    if (!Number.isSafeInteger(amount) || amount <= 0 || !PAYMENT_METHODS.has(method)) {
      return res.status(400).json({ message: 'To‘lov summasi va usulini to‘g‘ri kiriting.' });
    }
    try {
      const payment = {
        _id: new ObjectId(),
        type: 'installment',
        amount,
        method,
        receivedBy: res.locals.currentUser._id,
        paidAt: new Date(now()),
      };
      const updated = await customers.findOneAndUpdate(
        { _id: new ObjectId(req.params.id), remainingBalance: { $gte: amount } },
        {
          $push: { payments: payment },
          $inc: { totalPaid: amount, remainingBalance: -amount },
          $set: { updatedAt: payment.paidAt },
        },
        { returnDocument: 'after' },
      );
      if (updated) return res.status(201).json({ payment: publicPayment(payment), customer: publicCustomer(updated) });
      const customer = await customers.findOne({ _id: new ObjectId(req.params.id) });
      if (!customer) return res.status(404).json({ message: 'Mijoz topilmadi.' });
      return res.status(409).json({ message: 'To‘lov qolgan qarzdan katta.' });
    } catch (error) {
      logger.error('To‘lovni yozishda xatolik:', error);
      return res.status(500).json({ message: 'Serverda xatolik yuz berdi.' });
    }
  });
}

module.exports = { registerCustomerRoutes };
