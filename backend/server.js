import express from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { MongoMemoryServer } from 'mongodb-memory-server';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

// ---------- CONFIG ----------
const PORT = 5001;
const STAFF_KEY = process.env.STAFF_KEY || 'qskip-staff';
const MAX_ORDERS_PER_SLOT = 10;
const STATUSES = ['Received', 'Preparing', 'Ready', 'Collected', 'Cancelled'];
const ACTIVE_STATUSES = ['Received', 'Preparing'];

const SLOT_REGEX = /^\d{2}:\d{2} (AM|PM) - \d{2}:\d{2} (AM|PM)$/;

let mongod;

// ---------- SCHEMAS ----------
const menuItemSchema = new mongoose.Schema({
  itemId: { type: String, required: true, unique: true },
  itemName: { type: String, required: true },
  stallName: { type: String, required: true },
  category: { type: String, required: true },
  price: { type: Number, required: true },
  prepTimeMinutes: { type: Number, default: 5 },
  availabilityStatus: { type: String, default: 'In Stock' }
});
const MenuItem = mongoose.model('MenuItem', menuItemSchema);

const orderSchema = new mongoose.Schema({
  orderId: { type: String, unique: true, required: true },
  customerName: { type: String, required: true },
  regNo: { type: String, required: true },
  items: [{ id: String, name: String, qty: Number, price: Number }],
  totalPrice: { type: Number, required: true },
  slotTime: { type: String, required: true },
  paymentMethod: { type: String, default: 'Campus Wallet' },
  paymentStatus: { type: String, default: 'Demo Paid' },
  queueStatus: { type: String, enum: STATUSES, default: 'Received' }
}, { timestamps: true });
const Order = mongoose.model('Order', orderSchema);

// ---------- HELPERS ----------
function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

// Dynamic Wait Calculation
async function estimateWait(order) {
  if (!ACTIVE_STATUSES.includes(order.queueStatus)) {
    return { queuePosition: 0, estimatedWaitMinutes: 0 };
  }

  const ahead = await Order.find({
    queueStatus: { $in: ACTIVE_STATUSES },
    createdAt: { $lt: order.createdAt }
  });

  const itemIds = order.items.map(i => String(i.id));
  const menuItems = await MenuItem.find({ itemId: { $in: itemIds } });

  const maxItemPrepTime = menuItems.length > 0 
    ? Math.max(...menuItems.map(m => m.prepTimeMinutes || 5)) 
    : 5;

  const queueDelay = ahead.length * 2;
  const totalWaitMinutes = maxItemPrepTime + queueDelay;

  return { 
    queuePosition: ahead.length + 1, 
    estimatedWaitMinutes: totalWaitMinutes 
  };
}

function requireStaff(req, res, next) {
  if (req.get('x-staff-key') !== STAFF_KEY) {
    return res.status(401).json({ success: false, message: 'Staff access only' });
  }
  next();
}

async function seedMenu() {
  const filePath = path.join(__dirname, 'menu.json');
  if (!fs.existsSync(filePath)) throw new Error('backend/menu.json was not found');
  const items = JSON.parse(fs.readFileSync(filePath, 'utf8'));

  for (const item of items) {
    const { availabilityStatus, ...rest } = item;
    await MenuItem.updateOne(
      { itemId: item.itemId },
      { $set: rest,$setOnInsert: { availabilityStatus: availabilityStatus || 'In Stock' } },
      { upsert: true }
    );
  }
  console.log(`Menu loaded: ${items.length} items`);
}

// ---------- PUBLIC ROUTES ----------
app.get('/', (req, res) => {
  res.json({ success: true, message: 'Q-Skip backend is running' });
});

app.get('/api/menu', async (req, res) => {
  try {
    const category = req.query.category;
    const filter = {};
    if (category && category !== 'All') {
      filter.category = category === 'Beverages'
        ? { $regex: 'Juices & Beverages\vert{}Beverages',$options: 'i' }
        : { $regex: category,$options: 'i' };
    }
    const items = await MenuItem.find(filter).sort({ itemId: 1 });
    res.json({ success: true, count: items.length, menu: items });
  } catch (err) {
    console.error('Menu API error:', err);
    res.status(500).json({ success: false, message: 'Server error loading menu' });
  }
});

app.get('/api/slots', async (req, res) => {
  try {
    const rows = await Order.aggregate([
      { $match: { createdAt: { $gte: startOfToday() }, queueStatus: {$ne: 'Cancelled' } } },
      { $group: { _id: '$slotTime', booked: {$sum: 1 } } }
    ]);
    const slots = {};
    rows.forEach((r) => {
      slots[r._id] = { booked: r.booked, full: r.booked >= MAX_ORDERS_PER_SLOT };
    });
    res.json({ success: true, maxPerSlot: MAX_ORDERS_PER_SLOT, slots });
  } catch (err) {
    console.error('Slots error:', err);
    res.status(500).json({ success: false, message: 'Server error loading slots' });
  }
});

app.post('/api/orders', async (req, res) => {
  try {
    const { customerName, regNo, items, paymentMethod } = req.body;
    const slotTime = String(req.body.slotTime || '').trim();

    if (!customerName || !regNo || !Array.isArray(items) || items.length === 0 || !slotTime) {
      return res.status(400).json({
        success: false,
        message: 'Missing customer, item, or pickup-slot details'
      });
    }

    const booked = await Order.countDocuments({
      slotTime,
      createdAt: { $gte: startOfToday() },
      queueStatus: { $ne: 'Cancelled' }
    });
    if (booked >= MAX_ORDERS_PER_SLOT) {
      return res.status(409).json({
        success: false,
        message: 'This pickup slot is full. Please choose another slot.'
      });
    }

    const menuItems = await MenuItem.find({ itemId: { $in: items.map((i) => i.id) } });
    const menuById = Object.fromEntries(menuItems.map((m) => [m.itemId, m]));

    let calculatedTotal = 0;
    const verifiedItems = [];

    for (const item of items) {
      const menuItem = menuById[item.id];
      if (!menuItem || menuItem.availabilityStatus !== 'In Stock') {
        return res.status(400).json({
          success: false,
          message: `Item unavailable: ${item.name || item.id}`
        });
      }
      const qty = Number(item.qty);
      if (!Number.isInteger(qty) || qty < 1) {
        return res.status(400).json({ success: false, message: 'Invalid item quantity' });
      }
      calculatedTotal += menuItem.price * qty;
      verifiedItems.push({
        id: menuItem.itemId,
        name: menuItem.itemName,
        qty,
        price: menuItem.price
      });
    }

    calculatedTotal += 5; // Platform fee

    const orderId = `QS-${Date.now()}-${Math.floor(100 + Math.random() * 900)}`;
    const order = await Order.create({
      orderId,
      customerName,
      regNo,
      items: verifiedItems,
      totalPrice: calculatedTotal,
      slotTime,
      paymentMethod: paymentMethod || 'Campus Wallet',
      paymentStatus: 'Demo Paid',
      queueStatus: 'Received'
    });

    const wait = await estimateWait(order);

    res.status(201).json({
      success: true,
      message: 'Order placed successfully',
      orderId: order.orderId,
      totalPrice: order.totalPrice,
      ...wait
    });
  } catch (err) {
    console.error('Order creation error:', err);
    res.status(500).json({ success: false, message: 'Server error while placing order' });
  }
});

app.get('/api/orders', async (req, res) => {
  try {
    const { regNo } = req.query;
    if (!regNo) {
      return res.status(400).json({ success: false, message: 'regNo is required' });
    }
    const orders = await Order.find({ regNo }).sort({ createdAt: -1 }).limit(20);
    res.json({ success: true, count: orders.length, orders });
  } catch (err) {
    console.error('Order list error:', err);
    res.status(500).json({ success: false, message: 'Server error while fetching orders' });
  }
});

// Staff Dashboard Route: Filters out completed/collected/cancelled orders
app.get('/api/public-staff/orders', async (req, res) => {
  try {
    const orders = await Order.find({
      queueStatus: { $in: ['Received', 'Preparing', 'Ready'] }
    }).sort({ createdAt: 1 });
    res.json({ success: true, count: orders.length, orders });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error loading staff orders' });
  }
});

app.patch('/api/public-staff/orders/:orderId/status', async (req, res) => {
  try {
    const { status } = req.body;
    const order = await Order.findOne({ orderId: req.params.orderId });
    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }
    order.queueStatus = status;
    await order.save();
    res.json({ success: true, order });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error updating status' });
  }
});

// ROUTE: Kitchen Staff Stock Management (Toggle In Stock / Out of Stock)
app.patch('/api/public-staff/menu/:itemId/status', async (req, res) => {
  try {
    const { availabilityStatus } = req.body;
    if (!['In Stock', 'Out of Stock'].includes(availabilityStatus)) {
      return res.status(400).json({ success: false, message: 'Invalid availability status' });
    }

    const item = await MenuItem.findOne({ itemId: req.params.itemId });
    if (!item) {
      return res.status(404).json({ success: false, message: 'Menu item not found' });
    }

    item.availabilityStatus = availabilityStatus;
    await item.save();

    res.json({
      success: true,
      message: `Updated ${item.itemName} status to ${availabilityStatus}`,
      item
    });
  } catch (err) {
    console.error('Error updating item stock:', err);
    res.status(500).json({ success: false, message: 'Server error updating menu stock' });
  }
});

app.get('/api/orders/:orderId', async (req, res) => {
  try {
    const order = await Order.findOne({ orderId: req.params.orderId });
    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }
    const wait = await estimateWait(order);
    res.json({ success: true, order, ...wait });
  } catch (err) {
    console.error('Order lookup error:', err);
    res.status(500).json({ success: false, message: 'Server error while fetching order' });
  }
});

// ---------- START ----------
async function startServer() {
  try {
    if (process.env.MONGO_URI) {
      await mongoose.connect(process.env.MONGO_URI);
      console.log('MongoDB connected (MONGO_URI)');
    } else {
      const dbPath = path.join(__dirname, 'data');
      fs.mkdirSync(dbPath, { recursive: true });
      mongod = await MongoMemoryServer.create({
        instance: { dbPath, storageEngine: 'wiredTiger', port: 27018 }
      });
      await mongoose.connect(mongod.getUri());
      console.log('MongoDB connected (persistent, backend/data)');
    }

    await seedMenu();

    app.listen(PORT, () => {
      console.log(`Backend running at http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('Startup failed:', err);
    process.exitCode = 1;
  }
}

process.on('SIGINT', async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
  process.exit(0);
});

startServer();