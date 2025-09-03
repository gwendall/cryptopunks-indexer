export const CONTRACT_ADDRESS = "0xb47e3cd837ddf8e4c57f05d70ab865de6e193bbb";

// Minimal ABI: events only (CryptoPunks is not ERC-721 compliant)
export const PUNKS_ABI = [
  // Assignment when a punk is initially claimed or assigned
  "event Assign(address indexed to, uint256 indexed punkIndex)",

  // Transfer between addresses (no value in this event)
  "event PunkTransfer(address indexed from, address indexed to, uint256 indexed punkIndex)",

  // Offer lifecycle
  "event PunkOffered(uint256 indexed punkIndex, uint256 minValue, address indexed toAddress)",
  "event PunkNoLongerForSale(uint256 indexed punkIndex)",

  // Bid lifecycle
  "event PunkBidEntered(uint256 indexed punkIndex, uint256 value, address indexed fromAddress)",
  "event PunkBidWithdrawn(uint256 indexed punkIndex, uint256 value, address indexed fromAddress)",

  // Purchase
  "event PunkBought(uint256 indexed punkIndex, uint256 value, address indexed fromAddress, address indexed toAddress)",
];

export const DEFAULTS = {
  CHUNK_SIZE: 5000,
};

// Optional known deployment block for CryptoPunks (if known you can set via env DEPLOY_BLOCK)
// We will auto-discover if not provided.
export const DEFAULT_DEPLOY_BLOCK = null;
