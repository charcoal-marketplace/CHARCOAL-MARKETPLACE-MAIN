const ACCOUNT_API = "/api";

function accountToken(){
  return localStorage.getItem("token");
}

function accountHeaders(){
  const token=accountToken();
  return token
    ? {Authorization:`Bearer ${token}`,Accept:"application/json"}
    : {Accept:"application/json"};
}

function escapeHTML(value){
  return String(value ?? "")
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}

function requireAccount(){
  if(!accountToken()){
    window.location.replace("profile.html");
    return false;
  }
  return true;
}

function accountLogout(){
  localStorage.removeItem("token");
  localStorage.removeItem("user");
  window.location.replace("profile.html");
}

function nav(){
  return `<div class="nav">
    <a href="home.html">Home</a>
    <a href="vendor.html">Vendor</a>
    <a href="profile.html">Profile</a>
  </div>`;
}

async function loadOrders(){
  if(!requireAccount()) return;
  const box=document.getElementById("content");
  try{
    const res=await fetch(`${ACCOUNT_API}/orders/my`,{headers:accountHeaders()});
    const data=await res.json().catch(()=>[]);
    if(!res.ok) throw new Error(data.message||"Unable to load orders");
    if(!Array.isArray(data)||!data.length){
      box.innerHTML='<div class="card">No orders yet.</div>';
      return;
    }
    box.innerHTML=data.map(o=>`
      <div class="card">
        <strong>${escapeHTML(o.product_name||o.name||"Order item")}</strong>
        <p>Quantity: ${Number(o.quantity||0)}</p>
        <p>Subtotal: ${Number(o.subtotal_pi||0).toFixed(2)} Pi</p>
        <p>Status: ${escapeHTML(o.status||"pending")}</p>
        <p>Checkout: ${escapeHTML(o.checkout_ref||"")}</p>
      </div>`).join("");
  }catch(e){
    box.innerHTML=`<div class="card">Unable to load orders: ${escapeHTML(e.message)}</div>`;
  }
}

function loadCart(){
  let cart=[];
  try{cart=JSON.parse(localStorage.getItem("cart"))||[]}catch{}
  const box=document.getElementById("content");
  if(!cart.length){
    box.innerHTML='<div class="card">Your cart is empty.</div>';
    return;
  }
  let total=0;
  box.innerHTML=cart.map((item,i)=>{
    const qty=Number(item.qty||item.quantity||1);
    const price=Number(item.price||item.price_pi||0);
    total+=qty*price;
    return `<div class="card item">
      <div><strong>${escapeHTML(item.name)}</strong><br>${price.toFixed(2)} Pi × ${qty}</div>
      <button onclick="removeCartItem(${i})">Remove</button>
    </div>`;
  }).join("")+
  `<div class="card"><strong>Total: ${total.toFixed(2)} Pi</strong><br>
    <a class="action" href="checkout.html">Proceed to Checkout</a>
  </div>`;
}

function removeCartItem(index){
  let cart=[];
  try{cart=JSON.parse(localStorage.getItem("cart"))||[]}catch{}
  cart.splice(index,1);
  localStorage.setItem("cart",JSON.stringify(cart));
  loadCart();
}

async function loadNotifications(){
  if(!requireAccount()) return;
  const box=document.getElementById("content");
  try{
    const res=await fetch(`${ACCOUNT_API}/notifications`,{headers:accountHeaders()});
    const data=await res.json().catch(()=>[]);
    if(!res.ok) throw new Error(data.message||"Unable to load notifications");
    const rows=Array.isArray(data)?data:(data.notifications||[]);
    if(!rows.length){
      box.innerHTML='<div class="card">No notifications.</div>';
      return;
    }
    box.innerHTML=rows.map(n=>`
      <div class="card">
        <strong>${escapeHTML(n.type||"general")}</strong>
        <p>${escapeHTML(n.message)}</p>
        <small>${escapeHTML(n.created_at||"")}</small>
      </div>`).join("");
    fetch(`${ACCOUNT_API}/notifications/read-all`,{
      method:"POST",headers:accountHeaders()
    }).catch(()=>{});
  }catch(e){
    box.innerHTML=`<div class="card">${escapeHTML(e.message)}</div>`;
  }
}

function loadSaved(){
  const box=document.getElementById("content");
  box.innerHTML='<div class="card">No saved products are available yet. You can add products to your cart from the marketplace.</div>';
}

function loadPersonalInfo(){
  if(!requireAccount()) return;
  let user={};
  try{
    user=JSON.parse(localStorage.getItem("user")||"{}");
  }catch{}
  document.getElementById("content").innerHTML=`
    <div class="card">
      <p><strong>Name:</strong> ${escapeHTML(user.name||"Pi User")}</p>
      <p><strong>Pi Username:</strong> ${escapeHTML(user.pi_username||"Not available")}</p>
      <p><strong>Business:</strong> ${escapeHTML(user.business_name||"Not registered")}</p>
      <p><strong>Location:</strong> ${escapeHTML(user.business_location||"Not set")}</p>
      <p class="muted">Profile editing can be added after the account-profile API is enabled.</p>
    </div>`;
}

async function loadEarnings(){
  if(!requireAccount()) return;
  const box=document.getElementById("content");
  try{
    const res=await fetch(`${ACCOUNT_API}/orders/vendor`,{headers:accountHeaders()});
    const data=await res.json().catch(()=>[]);
    if(!res.ok) throw new Error(data.message||"Vendor access required");
    const rows=Array.isArray(data)?data:[];
    const total=rows.reduce((sum,row)=>sum+Number(row.subtotal_pi||0),0);
    box.innerHTML=`
      <div class="card"><h2>${total.toFixed(2)} Pi</h2><p>Gross value of your listed order items.</p></div>
      ${rows.map(r=>`<div class="card">
        <strong>${escapeHTML(r.name||r.product_name||"Product")}</strong>
        <p>${Number(r.subtotal_pi||0).toFixed(2)} Pi · ${escapeHTML(r.status||"pending")}</p>
      </div>`).join("")}`;
  }catch(e){
    box.innerHTML=`<div class="card">${escapeHTML(e.message)}</div>`;
  }
}

document.addEventListener("DOMContentLoaded",()=>{
  const page=document.body.dataset.page;
  if(page==="orders") loadOrders();
  if(page==="cart") loadCart();
  if(page==="notifications") loadNotifications();
  if(page==="saved") loadSaved();
  if(page==="personal") loadPersonalInfo();
  if(page==="earnings") loadEarnings();
});
