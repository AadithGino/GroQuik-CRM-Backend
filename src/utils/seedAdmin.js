import { connectDb } from '../config/db.js';
import { User } from '../models/user.model.js';
import { ROLES } from '../constants/crm.constants.js';

await connectDb();

const email = process.env.ADMIN_EMAIL || 'admin@groquik.local';
const password = process.env.ADMIN_PASSWORD || 'Admin@12345';

let user = await User.findOne({ email });
if (!user) {
  user = await User.create({ name: 'Admin', email, password, role: ROLES.ADMIN });
  console.log('Admin created:', email, password);
} else {
  console.log('Admin already exists:', email);
}

process.exit(0);
